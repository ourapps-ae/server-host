# Local workflow

Local only: repository `ourapps-ae/server-host` has no commits, pushes, remote changes or publishing without George's say-so. Licence wording remains deferred (`licenceStatus: "deferred"`).
Do not edit `mcinpoker/`, `skull/`, `aepm/`, `OurPoker/proof/` or `OurPoker/recipe/`.
Regenerate: `python3.12 -B /Users/george/Projects/com/my/tools/scaffold_component.py components/server-host --spec components/server-host/authoring/spec.json --render`.
Check: `python3.12 -B /Users/george/Projects/com/my/tools/check_component.py components/server-host`. Suite commands (from the package root): `node --test tests/web.test.ts`.
Always run Python with `-B`; never write bytecode into the repository.
