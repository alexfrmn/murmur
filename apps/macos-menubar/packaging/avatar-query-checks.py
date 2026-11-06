import base64
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('query_avatar', Path(__file__).resolve().parent.parent / 'Sources/MurmurMenuBar/Resources/mesh-comms-query.py')
Q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(Q)
# A synthetic edition: one demo person may show a portrait, no operator roster in the checks.
Q.AVATAR_IDS = {'demo'}
Q.AVATARS = {'person:demo': '/mesh-comms-avatar-demo.jpg'}
Q.PRIVATE_PEERS = {'agent-private-demo'}


class AvatarTests(unittest.TestCase):
    def setUp(self):
        self.photo = '/mesh-comms-avatar-demo.jpg'
        self.people = {'privacy':'operator_metadata_only_tailnet', 'people':[
            {'id':'person:demo','photo':self.photo,'photo_note':'Unconfirmed synthetic portrait'}],
            'bindings':[{'person':'person:demo','agent':'agent-demo'}]}
        self.share = {'privacy':'metadata-only', 'private_contours':[]}
        self.data = {'privacy':'owner-metadata','people':[{'id':'person:demo','agents':['agent-demo']}]}

    def project(self):
        return Q.add_avatars(self.data, self.people, self.share)

    def test_exact_existing_photo_and_note_survive_old_projection(self):
        row = self.project()['people'][0]
        self.assertEqual((row['photo'],row['photo_note'],row['photo_privacy']),
                         (self.photo,'Unconfirmed synthetic portrait','owner-approved-avatar'))

    def test_approved_current_unbound_portrait_has_no_message_route(self):
        self.data['people'][0].update(agents=[], writable_agents=[], contact_state='unlinked')
        self.people['bindings']=[]
        row=self.project()['people'][0]
        self.assertEqual(row['photo'],self.photo)
        self.assertEqual(row['writable_agents'],[])
        self.data['people'][0]['contact_state']='status_only'
        self.assertEqual(self.project()['people'][0]['photo'],self.photo)
        self.assertEqual(self.project()['people'][0]['writable_agents'],[])

    def test_absent_url_wrong_person_and_traversal_references_are_dropped(self):
        for photo in [None,'https://example.com/a.jpg','/mesh-comms-avatar-dan.jpg','/mesh-comms-avatar-../demo.jpg']:
            self.people['people'][0]['photo'] = photo
            row = self.project()['people'][0]
            self.assertNotIn('photo',row); self.assertNotIn('photo_note',row)

    def test_explicit_portrait_survives_private_binding_without_history_access(self):
        for peer in ['private-demo','agent-private-demo']:
            self.people['bindings'][0]['agent'] = peer
            self.share['private_contours'] = [{'peer_identity':peer,'privacy':'status-only'}]
            row = self.project()['people'][0]
            self.assertEqual(row['photo'],self.photo)
            self.assertEqual(row['photo_privacy'],'owner-approved-avatar')

    def test_wrong_source_privacy_and_former_person_fail_closed(self):
        self.people['privacy']='public'
        self.assertNotIn('photo',self.project()['people'][0])
        self.people['privacy']='operator_metadata_only_tailnet';self.people['people'][0]['history']=True
        self.assertNotIn('photo',self.project()['people'][0])

    def test_approved_asset_is_read_only_when_http_allowlist_matches(self):
        self.project()
        image = b'\xff\xd8\xffsynthetic-jpeg-fixture'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/self.photo[1:]).write_bytes(image)
            reader=SimpleNamespace(ALLOWED={self.photo:(self.photo[1:],'image/jpeg')})
            with patch.object(Q,'dispatch',return_value=self.data),patch.object(Q,'load',return_value=reader):
                result=Q.read_avatar('person:demo',root)
                self.assertEqual(base64.b64decode(result['data']),image)
                self.assertEqual(result['privacy'],'owner-approved-avatar')
                reader.ALLOWED={}
                with patch.object(Q.os,'open') as image_open:
                    with self.assertRaises(ValueError):Q.read_avatar('person:demo',root)
                    image_open.assert_not_called()

    def test_absent_photo_no_image_open(self):
        with patch.object(Q,'dispatch',return_value=self.data),patch.object(Q.os,'open') as image_open:
            with self.assertRaises(ValueError):Q.read_avatar('person:demo')
            image_open.assert_not_called()

    def test_symlink_oversized_and_wrong_format_refused(self):
        self.project()
        reader=SimpleNamespace(ALLOWED={self.photo:(self.photo[1:],'image/jpeg')})
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);asset=root/self.photo[1:];other=root/'other.jpg';other.write_bytes(b'\xff\xd8\xfffake')
            asset.symlink_to(other)
            with patch.object(Q,'dispatch',return_value=self.data),patch.object(Q,'load',return_value=reader):
                with self.assertRaises(OSError):Q.read_avatar('person:demo',root)
                asset.unlink();asset.write_bytes(b'\xff\xd8\xff'+b'a'*Q.MAX_AVATAR_BYTES)
                with self.assertRaises(ValueError):Q.read_avatar('person:demo',root)
                asset.write_bytes(b'not an image')
                with self.assertRaises(ValueError):Q.read_avatar('person:demo',root)

    def test_request_accepts_no_url_path_or_unknown_identity(self):
        for request in [{'action':'avatar','person':'person:demo','path':'/etc/passwd'},
                        {'action':'avatar','person':'private:demo'},
                        {'action':'avatar','person':'https://example.com'}]:
            with self.subTest(request=request),patch.object(Q.os,'open') as image_open:
                with self.assertRaises(ValueError):Q.dispatch(request)
                image_open.assert_not_called()

if __name__ == '__main__':unittest.main()
