# 0040 output control governance

Adds immutable response-template selectors required by the output-control runtime:

- jurisdiction;
- business line;
- legal-disclaimer version;
- platform or tenant scope.

The migration keeps existing rows compatible with conservative defaults and adds a
runtime selector index. Roll back only after retiring policy bundles that contain the
new selector metadata; then drop `response_templates_runtime_selector_idx`, the scope
check, and the four added columns in a maintenance window.
