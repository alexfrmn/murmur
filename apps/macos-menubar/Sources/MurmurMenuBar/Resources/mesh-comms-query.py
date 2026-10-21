#!/usr/bin/env python3
"""Bundled owner SSH reader. Executed in memory; installs nothing on the server.

Only imports the existing operator dashboard readers. No inbox read marks, wakes,
sends, private message bodies or credentials. JSON request travels on stdin.
"""
import base64
import os
import stat
import contextlib
import importlib.util
import io
import json
import re
import sys
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

def _setting(name, pattern, default=''):
    """Edition settings arrive as environment from the app, already validated there; check again here."""
    value = os.environ.get(name, default)
    return value if re.fullmatch(pattern, value) and '..' not in value.split('/') else default


def _setting_list(name, pattern):
    return {item for item in os.environ.get(name, '').split(',') if re.fullmatch(pattern, item)}


ROOT = Path.home() / _setting('MURMUR_COMPANION_ROOT', r'[A-Za-z0-9_.][A-Za-z0-9._-]*(/[A-Za-z0-9_.][A-Za-z0-9._-]*)*', 'murmur-companion')
DATABASE = _setting('MURMUR_COMPANION_DB', r'[A-Za-z0-9_.][A-Za-z0-9._-]*(/[A-Za-z0-9_.][A-Za-z0-9._-]*)*')
OWNER = _setting('MURMUR_COMPANION_OWNER', r'[a-z0-9_]{1,40}', 'owner')
AVATAR_IDS = _setting_list('MURMUR_COMPANION_AVATARS', r'[a-z0-9_]{1,40}')
# Portable mirror of mesh_comms_policy.PRIVATE_PEERS. Contract tests require parity;
# the in-memory SSH reader must also deny these when an old edition omits settings.
PRIVATE_PEERS = {'agent-viola-alex','shaper-viola'} | _setting_list('MURMUR_COMPANION_PRIVATE', r'[a-z0-9][a-z0-9._-]{0,62}')


def _owner_file(name):
    """Optional owner-side JSON beside the helpers: names and threads stay on the owner's server."""
    try:
        value = json.loads((ROOT / name).read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


OWNER_THREADS = {agent: {'title': row['title'], 'url': row['url']}
                 for agent, row in _owner_file('owner-threads.json').items()
                 if isinstance(row, dict) and isinstance(row.get('title'), str) and isinstance(row.get('url'), str)}
AGENT_LABELS = {agent: label for agent, label in _owner_file('agent-labels.json').items() if isinstance(label, str)}
AVATARS = {'person:' + pid: '/mesh-comms-avatar-' + pid + '.jpg' for pid in AVATAR_IDS}
MAX_AVATAR_BYTES = 262144
CLOSED = {'answered', 'no_reply_needed', 'reported_complete', 'cancelled'}


def load(name, filename, root=ROOT):
    spec = importlib.util.spec_from_file_location(name, root / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def responsibility(status):
    if status in {'awaiting_user', 'needs_owner_decision'}:
        return OWNER
    if status in {'awaiting_implementation_owner', 'awaiting_agent'}:
        return 'agent'
    if status in {'awaiting_peer_human', 'awaiting_external_owner', 'awaiting_peer'}:
        return 'peer'
    return 'verify'


def augment(data, monitor, share):
    if data.get('privacy') != 'owner-metadata' or monitor.get('privacy') != 'operator-only-metadata' or share.get('privacy') != 'metadata-only':
        raise ValueError('safe_snapshot_unavailable')
    private = set(PRIVATE_PEERS)
    for person in data.get('people', []):
        if person.get('privacy') == 'status-only' or person.get('contact_state') == 'status_only':
            private.update(person.get('agents', []))
    contours = []
    for c in share.get('private_contours', []):
        private.update([c.get('local_identity'), c.get('peer_identity')])
        if c.get('privacy') != 'status-only':
            continue
        contours.append({
            'id': c.get('id'), 'name': c.get('peer_label') or 'Private connection',
            'privacy': 'status-only',
            **{k: c.get(k) for k in ['service_active', 'last_at', 'updated_at', 'inbound_count', 'outbound_count', 'failed_count', 'waiting_count', 'handler_configured', 'handler_service_active', 'last_wake_status', 'model_reply_verified', 'reply_delivery', 'last_model_reply_at']},
        })
    # monitor.json can predate the current share-data privacy boundary. Apply the
    # same fresh denylist to attention before any metadata leaves the owner host.
    attention = data.get('attention')
    if attention is not None:
        if not isinstance(attention, dict) or not isinstance(attention.get('items'), list):
            raise ValueError('safe_attention_unavailable')
        private_sources = {m.get('id') for m in share.get('messages', []) if m.get('id')
                           and (m.get('peer_identity') in private or m.get('local_identity') in private)}
        items = []
        for item in attention['items']:
            if not isinstance(item, dict) or not isinstance(item.get('source_ids'), list):
                raise ValueError('safe_attention_unavailable')
            if item.get('peer') in private or any(mid in private_sources for mid in item['source_ids']):
                continue
            items.append(item)
        attention = {**attention, 'items': items}
        if 'counts' in attention:
            attention['counts'] = {kind: sum(item.get('kind') == kind for item in items)
                                   for kind in attention['counts']}
        if 'actionable_count' in attention:
            attention['actionable_count'] = sum(item.get('actionable') is True for item in items)
        data['attention'] = attention
    topics = list(monitor.get('topics', []))
    covered = {t.get('source_id') for t in topics if t.get('source_id')}
    topics += [q for q in monitor.get('questions', []) if not q.get('source_id') or q.get('source_id') not in covered]
    questions = []
    for t in topics:
        if t.get('peer') in private or t.get('status') in CLOSED:
            continue
        row = {k: t.get(k) for k in ['id', 'title', 'peer', 'status', 'source_date', 'reviewed_at', 'next_action', 'conversation', 'source_id']}
        row['responsibility'] = responsibility(t.get('status'))
        questions.append(row)
    questions.sort(key=lambda q: q.get('source_date') or '', reverse=True)
    for person in data.get('people', []):
        labels = person.setdefault('agent_labels', {})
        for peer in person.get('agents', []):
            if not isinstance(labels.get(peer), str) or labels[peer].strip() in {'', '-', '—', '–'}:
                labels[peer] = AGENT_LABELS.get(peer, peer)
    data.update(private_contours=contours, owner_threads=OWNER_THREADS,
                questions=questions[:100], pending_count=len(questions),
                decision_count=sum(q['responsibility'] == OWNER for q in questions),
                question_scope='Recorded open questions; delivery is not a semantic answer.')
    return data



def add_roster(data, people, share):
    """Current registry contacts remain visible without granting a send route."""
    if people.get('privacy') != 'operator_metadata_only_tailnet' or share.get('privacy') != 'metadata-only' or data.get('privacy') != 'owner-metadata':
        raise ValueError('safe_roster_unavailable')
    seen = {p.get('id') for p in data.get('people', [])}
    private = set(PRIVATE_PEERS)
    for contour in share.get('private_contours', []):
        private.update((contour.get('local_identity'), contour.get('peer_identity')))
    private_people = {b.get('person') for b in people.get('bindings', []) if b.get('agent') in private}
    for person in people.get('people', []):
        pid = person.get('id')
        if (not isinstance(pid, str) or not pid.startswith('person:') or
                pid in seen or pid in private_people or person.get('history') or person.get('privacy') in {'private', 'status-only'}):
            continue
        agents = sorted({b['agent'] for b in people.get('bindings', []) if b.get('person') == pid and b.get('agent') not in private})
        data['people'].append({'id': pid, 'name': person.get('name') or pid,
                              'nickname': person.get('nickname'), 'role': person.get('role'),
                              'agents': agents, 'agent_labels': {a: AGENT_LABELS.get(a, a) for a in agents}, 'writable_agents': [], 'last_at': None,
                              'contact_state': 'unlinked'})
        seen.add(pid)
    for person in data.get('people', []):
        person['contact_state'] = person.get('contact_state') or ('status_only' if person.get('privacy') == 'status-only' else 'configured')
    data['roster_at'] = people.get('observed_at')
    return data


def add_flows(data, share, now=None):
    """Same retained-message counts as the owner graph, never a claim of liveness.

    A protocol ID can occur in multiple store snapshots. The graph deduplicates
    by ID, local identity, peer identity and direction, so the companion does too.
    Missing/failed sources cannot establish an observed zero.
    """
    if data.get('privacy') != 'owner-metadata' or share.get('privacy') != 'metadata-only':
        raise ValueError('safe_snapshot_unavailable')
    now = now or datetime.now(timezone.utc)
    private = set(PRIVATE_PEERS) | set(share.get('retired_identities', []))
    for person in data.get('people', []):
        if person.get('privacy') == 'status-only' or person.get('contact_state') == 'status_only':
            private.update(person.get('agents', []))
    for contour in share.get('private_contours', []):
        private.update((contour.get('local_identity'), contour.get('peer_identity')))
    sources = share.get('sources') or []
    # Content-free source receipts only. Raw errors, paths and private-contour
    # counters never enter the native companion projection.
    data['flow_sources'] = [
        {**{'store': source['store'], 'ok': source.get('ok') if isinstance(source.get('ok'), bool) else None},
         **({'observed_at': source['observed_at']} if isinstance(source.get('observed_at'), str)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{8,30}', source['observed_at']) else {})}
        for source in sources[:20] if isinstance(source, dict)
        and isinstance(source.get('store'), str) and re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,62}', source['store'])
    ]
    complete = bool(sources) and all(s.get('ok') is True for s in sources) and share.get('truncated') is False
    rows, seen = {}, set()
    for message in share.get('messages', []):
        peer, local, direction = (message.get(k) for k in ('peer_identity', 'local_identity', 'direction'))
        if peer in private or local in private or not peer or not local or not message.get('id') or direction not in {'inbound', 'outbound'}:
            continue
        try:
            at = datetime.fromisoformat(message.get('date', '').replace('Z', '+00:00'))
            if at.tzinfo is None or at > now:
                continue
        except (TypeError, ValueError, AttributeError):
            continue
        key = (message['id'], local, peer, direction)
        if key in seen:
            continue
        seen.add(key)
        row = rows.setdefault(peer, {'inbound_count': 0, 'outbound_count': 0, 'last_at': None})
        row[direction + '_count'] += 1
        if row['last_at'] is None or at > datetime.fromisoformat(row['last_at'].replace('Z', '+00:00')):
            row['last_at'] = message['date']
    scope = 'retained_snapshot' if complete else 'partial_retained_snapshot'
    if not complete:
        for row in rows.values():
            for key in ('inbound_count', 'outbound_count'):
                if row[key] == 0:
                    row[key] = None
    for person in data.get('people', []):
        person.pop('flows', None)
        person.pop('flow_window', None)
        if person.get('privacy') == 'status-only' or any(a in private for a in person.get('agents', [])):
            continue
        person['flows'] = {peer: {**rows.get(peer, {'inbound_count': 0 if complete else None,
                                                  'outbound_count': 0 if complete else None, 'last_at': None}),
                                  'source_at': share.get('ts'), 'scope': scope}
                           for peer in person.get('agents', [])}
        person['flow_window'] = 'Retained messages in the server and Mac snapshots' + ('' if complete else ' · partial source')
    return data


def contact_history(peer, root, stores):
    """Bounded metadata-only contact journal; bodies still require exact on-demand read."""
    if not isinstance(peer, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,62}', peer):
        raise ValueError('invalid_peer')
    share = json.loads((root / 'share-data.json').read_text())
    if share.get('privacy') != 'metadata-only':
        raise ValueError('safe_snapshot_unavailable')
    private = set(PRIVATE_PEERS)
    for contour in share.get('private_contours', []):
        private.update((contour.get('local_identity'), contour.get('peer_identity')))
    if peer in private:
        raise ValueError('private_history_unavailable')
    rows = [m for m in share.get('messages', []) if m.get('store') in stores and m.get('id')
            and m.get('peer_identity') == peer and m.get('local_identity') not in private]
    rows = list({(m['store'], m['id']): m for m in rows}.values())
    rows.sort(key=lambda m: m.get('date') or '', reverse=True)
    return {'privacy': 'owner-only-search', 'matches': [
        {**{k: m.get(k) for k in ('id', 'store', 'date', 'peer_identity', 'local_identity', 'direction', 'conversation_id')},
         'excerpt': 'Incoming message' if m.get('direction') == 'inbound' else 'Outgoing message'} for m in rows[:40]],
        'total': len(rows), 'truncated': len(rows) > 40, 'searched': len(rows),
        'unavailable': [], 'source_at': share.get('ts'), 'scope': 'Contact history; metadata only until a message is opened.'}


def add_avatars(data, people, share):
    """Only current ordinary people with existing operator-approved exact assets."""
    private = set(PRIVATE_PEERS)
    for contour in share.get('private_contours', []):
        private.update((contour.get('local_identity'), contour.get('peer_identity')))
    private_people = {b.get('person') for b in people.get('bindings', []) if b.get('agent') in private}
    source = {p.get('id'): p for p in people.get('people', [])}
    for person in data.get('people', []):
        for key in ('photo', 'photo_note', 'photo_privacy'):
            person.pop(key, None)
        p = source.get(person.get('id'), {})
        photo = AVATARS.get(person.get('id'))
        if (people.get('privacy') != 'operator_metadata_only_tailnet' or
            share.get('privacy') != 'metadata-only' or data.get('privacy') != 'owner-metadata' or
            not photo or p.get('photo') != photo or p.get('history') or
            p.get('privacy') in {'private', 'status-only'} or person.get('id') in private_people or
            person.get('contact_state') == 'status_only' or any(peer in private for peer in person.get('agents', []))):
            continue
        person.update(photo=photo, photo_privacy='owner-approved-avatar',
                      photo_note=p.get('photo_note') if isinstance(p.get('photo_note'), str) else None)
    return data


def read_avatar(person, root=ROOT):
    # The request supplies an exact roster identity, never a URL or a file path.
    if person not in AVATARS:
        raise ValueError('avatar_unavailable')
    data = dispatch({'action': 'snapshot'}, root)
    row = next((p for p in data.get('people', []) if p.get('id') == person and
                p.get('photo_privacy') == 'owner-approved-avatar'), {})
    photo = row.get('photo')
    if photo != AVATARS[person]:
        raise ValueError('avatar_unavailable')
    reader = load('murmur_avatar_allowlist', 'serve.py', root)
    allowed = reader.ALLOWED.get(photo)
    if allowed != (photo[1:], 'image/jpeg'):
        raise ValueError('avatar_unavailable')
    # Exact allowlisted basename; no symlinks, directories or oversized reads.
    fd = os.open(root / allowed[0], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_AVATAR_BYTES:
            raise ValueError('avatar_unavailable')
        image = stream.read(MAX_AVATAR_BYTES + 1)
    if len(image) > MAX_AVATAR_BYTES or not image.startswith(b'\xff\xd8\xff'):
        raise ValueError('avatar_unavailable')
    return {'privacy': 'owner-approved-avatar', 'person': person, 'photo': photo,
            'mime': allowed[1], 'data': base64.b64encode(image).decode('ascii')}


def dispatch(request, root=ROOT):
    if not isinstance(request, dict):
        raise ValueError('invalid_request')
    action = request.get('action')
    if action == 'snapshot':
        companion = load('murmur_companion_reader', 'companion.py', root)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            companion.main()
        share = json.loads((root/'share-data.json').read_text())
        data = augment(json.loads(output.getvalue()), json.loads((root/'monitor.json').read_text()), share)
        people = json.loads((root/'people-data.json').read_text())
        data = add_roster(data, people, share)
        data = add_avatars(data, people, share)
        data = add_flows(data, share)
        # Optional owner-side metadata projection; old servers remain readable.
        # Its fixed allowlist excludes private message text and traffic counts.
        try:
            projector = load('murmur_private_status', 'mesh_comms_private.py', root)
            data['private_contours'] = projector.project(share.get('private_contours', []),
                _owner_file('private-work-status.json'), OWNER_THREADS)
        except FileNotFoundError:
            for contour in data.get('private_contours', []):
                contour['source_fresh'] = None
                for key in ['inbound_count','outbound_count','waiting_count','failed_count']:
                    contour.pop(key, None)
        # Expose fixed diagnostic codes only. Raw runner errors and session paths
        # stay on the server. A failed wake is separate from transport delivery.
        db_path = Path.home()/DATABASE if DATABASE else None
        try:
            if db_path is None:
                raise sqlite3.Error('no_database')
            with sqlite3.connect('file:'+str(db_path)+'?mode=ro',uri=True) as db:
                for peer, item in data.get('peer_policy', {}).get('peers', {}).items():
                    row = db.execute("select wake_error from local_messages where direction='inbound' and sender=? order by created_at desc limit 1",(peer,)).fetchone()
                    error = str(row[0]) if row else ''
                    if error.startswith('codex-app-server-final-empty:'):
                        item['wake_reason'] = 'empty_final_reply'
                    elif error == 'audit-require-approval':
                        item['wake_reason'] = 'owner_approval_required'
        except sqlite3.Error:
            pass  # Preserve the existing source's unknown/recorded_error state.
        return data
    if action == 'avatar':
        if set(request) != {'action', 'person'} or not isinstance(request.get('person'), str):
            raise ValueError('invalid_avatar_request')
        return read_avatar(request['person'], root)
    if action not in {'search', 'read', 'history'}:
        raise ValueError('unsupported_action')
    reader = load('murmur_message_reader', 'serve.py', root)
    if action == 'history':
        if set(request) != {'action', 'peer'}:
            raise ValueError('invalid_history_request')
        return contact_history(request.get('peer'), root, reader.MESSAGE_STORES)
    if action == 'search':
        query = request.get('query')
        if not isinstance(query, str) or not 2 <= len(query.strip()) <= 160:
            raise ValueError('query_length')
        code, result = reader.search_messages(query, root=root)
    else:
        store, mid = request.get('store'), request.get('id')
        if not isinstance(store, str) or not isinstance(mid, str):
            raise ValueError('invalid_message')
        code, result = reader.read_message(store, mid, root=root)
    if code != 200:
        raise ValueError(result.get('error', 'source_unavailable'))
    return result


def main():
    # Fixed owner location, never a path or command supplied by a request.
    sys.path.insert(0, str(ROOT))
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('request_too_large')
        result = dispatch(json.loads(raw))
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        # Tracebacks could reveal configuration/paths; return a bounded error.
        print(json.dumps({'error': 'owner_read_unavailable'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
