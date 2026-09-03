# 0030 Guard resource control

Adds the complete Agent lifecycle resource vector required by UWP-07. Existing rows
receive conservative defaults. Apply this migration before deploying code that reserves
browser, process, connection, file, OCR, media, or Guard-inference resources.

Rollback requires first stopping writers that use the new dimensions, then dropping the
constraint and columns. Dropping them discards accumulated usage evidence and therefore
requires release-manager approval and audit evidence.
