# Send service profile

Murmur 2.x uses `DATA_DIR` as its canonical profile directory variable. The Python
send service requires an explicit absolute value before binding its socket or
starting work. `MURMUR_DATA_DIR` is accepted only as a legacy alias; if both are
set, their resolved paths must agree. Neither variable set, an empty value, a
relative path or conflicting profiles causes a clear startup failure.

The default send script and working directory resolve relative to the checked-out
service script. They no longer point to a private infrastructure installation.
Explicit `MURMUR_SEND_SCRIPT` and `MURMUR_CWD` overrides remain supported. Self-tests
run without a production profile. This source change does not restart an installed
service or migrate its configuration.
