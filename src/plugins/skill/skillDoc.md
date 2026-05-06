## <skill path="[path-or-url]"/> - Drop in a deep skill

Example: <skill path="docs/refactoring.md"/>
<!-- Single-file skill: archived at skill://refactoring (summarized). -->
Example: <skill path="docs/playbook/"/>
<!-- Folder skill: index.md → skill://playbook (summarized). All other *.md → skill://playbook/<relpath> (archived). Navigate via <get skill://playbook/<page>>. -->
Example: <skill path="https://example.com/team-skill.zip"/>
<!-- URL skill: fetch + unpack. .zip or Content-Type: application/zip → multi-file deep skill. Otherwise single file. -->
<!-- Inside a multi-file skill, link sister pages with absolute URIs: [next](skill://playbook/next). -->
