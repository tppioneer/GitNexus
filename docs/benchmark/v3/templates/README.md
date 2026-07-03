# New project templates

Copy `project/` into a new benchmark version and rename it to the project
slug. Replace every `REPLACE_*` marker before validation. Template artifacts
are intentionally marked `draft-ground-truth`; `version_admin.py validate`
rejects draft artifacts before formal execution.

Required evidence for every ground truth:

1. direct source inspection;
2. repository-wide text-search confirmation;
3. graph/call-relation confirmation where the case claims graph advantage;
4. explicit false-positive exclusions;
5. executable validation commands and a fixed target commit.
