Session apps publishing (docs/feat/session-apps-publish.md): a permission_request
whose tool is `app_publish` (publishing a presented HTML artifact as a public web
page) must NEVER be auto-accepted, and it is offered allow-once or deny only. An
older client's auto-accept would answer it allow-once, putting a page on the public
internet with no human, so a mixed pair must fail at initialize instead. Additive
in the same task: the display update `apps`, the snapshot field `apps` and the
method `session/app_unpublish`.
