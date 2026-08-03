# Changelog

## [0.3.1](https://github.com/Kirari04/folio-paperless/compare/v0.3.0...v0.3.1) (2026-08-03)


### Bug Fixes

* **auth:** recover biometric unlock after resume ([4debda6](https://github.com/Kirari04/folio-paperless/commit/4debda6b129fdbf8ecf57652940ae1b5826c7516))
* **auth:** recover biometric unlock after resume ([bc18dd0](https://github.com/Kirari04/folio-paperless/commit/bc18dd00a966a83e215c56804a46bf4554128005))
* **auth:** recover biometric unlock after resume ([6089b88](https://github.com/Kirari04/folio-paperless/commit/6089b88c2575dcc6a9c5d618ea1f055f7d9a794f))

## [0.3.0](https://github.com/Kirari04/folio-paperless/compare/v0.2.0...v0.3.0) (2026-08-03)


### Features

* add advanced viewer and Paperless 3 workflows ([#22](https://github.com/Kirari04/folio-paperless/issues/22), [#23](https://github.com/Kirari04/folio-paperless/issues/23)) ([2a1cd77](https://github.com/Kirari04/folio-paperless/commit/2a1cd7750d795ccc695f93ba001d33b582997a87))
* add bulk library and catalog workflows ([#17](https://github.com/Kirari04/folio-paperless/issues/17), [#19](https://github.com/Kirari04/folio-paperless/issues/19)) ([7f06b26](https://github.com/Kirari04/folio-paperless/commit/7f06b263727310dbfb7c9460990ec2f53ecc8c7a))
* add durable intake, uploads, and task center ([#14](https://github.com/Kirari04/folio-paperless/issues/14), [#16](https://github.com/Kirari04/folio-paperless/issues/16), [#18](https://github.com/Kirari04/folio-paperless/issues/18)) ([6fc7358](https://github.com/Kirari04/folio-paperless/commit/6fc7358237b3924d811a98c9bb9e8c3618cf3a7c))
* add localized platform integrations and distribution ([#15](https://github.com/Kirari04/folio-paperless/issues/15), [#20](https://github.com/Kirari04/folio-paperless/issues/20), [#21](https://github.com/Kirari04/folio-paperless/issues/21)) ([090f1d0](https://github.com/Kirari04/folio-paperless/commit/090f1d0e36b5a731a3e8fcde11e29659ec560d53))
* add profile-scoped data and API foundations ([#15](https://github.com/Kirari04/folio-paperless/issues/15), [#18](https://github.com/Kirari04/folio-paperless/issues/18), [#20](https://github.com/Kirari04/folio-paperless/issues/20), [#23](https://github.com/Kirari04/folio-paperless/issues/23)) ([add02b5](https://github.com/Kirari04/folio-paperless/commit/add02b5379c17c787167fc8547a97f8efb47dda0))
* **core:** add profile-scoped auth, persistence, and offline tasks ([8b42bb7](https://github.com/Kirari04/folio-paperless/commit/8b42bb7a352be55e8fac0b73cef6064da9cfa843))
* **documents:** add bulk, catalog, viewer, and Paperless 3 workflows ([f971fad](https://github.com/Kirari04/folio-paperless/commit/f971fadde03916dee9ca4ce981eebd896bbf2793))
* **intake:** add durable shared-file uploads and scan presets ([e817fe7](https://github.com/Kirari04/folio-paperless/commit/e817fe7796cec52cc73f710d66df9236e22f1557))
* **ios:** add AltStore and SideStore distribution ([#26](https://github.com/Kirari04/folio-paperless/issues/26)) ([2166643](https://github.com/Kirari04/folio-paperless/commit/216664347245d42ca540586a01301de0ea122085))
* **ios:** harden app for unsigned GitHub releases ([#13](https://github.com/Kirari04/folio-paperless/issues/13)) ([79edb44](https://github.com/Kirari04/folio-paperless/commit/79edb4459f21819b6a6c34e620727a00c0d4b7cf))
* **platform:** add localization, OS integrations, and distribution ([c794a35](https://github.com/Kirari04/folio-paperless/commit/c794a35f3373cbfb137228a7a9e28d911a836e51))
* ship profiles, intake, workflows, and platform integrations ([2372230](https://github.com/Kirari04/folio-paperless/commit/2372230c4f3332b8d085a3a83f471b37d20c5abe))


### Bug Fixes

* **android:** avoid unresolved Material theme color ([#20](https://github.com/Kirari04/folio-paperless/issues/20)) ([e0ce02f](https://github.com/Kirari04/folio-paperless/commit/e0ce02f61abdbf9bd22950a7502dcd981a476c95))
* **auth:** validate iOS client certificate chains ([#15](https://github.com/Kirari04/folio-paperless/issues/15)) ([4577fd4](https://github.com/Kirari04/folio-paperless/commit/4577fd41017947e95457d3d25fec3b0fd59ba0f9))
* **ci:** configure Metro for SQLite web export ([#18](https://github.com/Kirari04/folio-paperless/issues/18)) ([35aa16a](https://github.com/Kirari04/folio-paperless/commit/35aa16a4cc0df95c3168553f9dc116bb5648f5cc))
* **ci:** verify self-signed Android upload keys ([#21](https://github.com/Kirari04/folio-paperless/issues/21)) ([8eda336](https://github.com/Kirari04/folio-paperless/commit/8eda3365d33c970ab0282772dd3e2ed6971aee59))
* **core:** harden profile authority and workspace capabilities ([#15](https://github.com/Kirari04/folio-paperless/issues/15) [#18](https://github.com/Kirari04/folio-paperless/issues/18) [#23](https://github.com/Kirari04/folio-paperless/issues/23)) ([8f87ec5](https://github.com/Kirari04/folio-paperless/commit/8f87ec5212fe13e96649a7d94934d9bf1f5748ad))
* **core:** keep upload owner validation in foundation ([#15](https://github.com/Kirari04/folio-paperless/issues/15) [#16](https://github.com/Kirari04/folio-paperless/issues/16)) ([3e7ab75](https://github.com/Kirari04/folio-paperless/commit/3e7ab750b3969919ed816a271b4ca4ac8971c705))
* **intake:** preserve reconnect-mode intake and upload semantics ([#14](https://github.com/Kirari04/folio-paperless/issues/14) [#16](https://github.com/Kirari04/folio-paperless/issues/16)) ([c13c72f](https://github.com/Kirari04/folio-paperless/commit/c13c72f29778adbaf45923e4722a14598c829154))
* **ios:** declare reviewed sideload entitlements ([fe25cc8](https://github.com/Kirari04/folio-paperless/commit/fe25cc811996e0ac0d5ed7c5d34183888151c3a0))
* **ios:** simplify platform module definition ([1b42c07](https://github.com/Kirari04/folio-paperless/commit/1b42c07a01cd3537216cb4719059343d334d9c9c))
* **platform:** harden native routing, colors, sharing, and docs ([#20](https://github.com/Kirari04/folio-paperless/issues/20) [#21](https://github.com/Kirari04/folio-paperless/issues/21)) ([9b2a86f](https://github.com/Kirari04/folio-paperless/commit/9b2a86f5a0d50ace3bf2216dd5c9b24aff5eda2f))
* **theme:** refresh Android semantic colors safely ([#20](https://github.com/Kirari04/folio-paperless/issues/20)) ([6425053](https://github.com/Kirari04/folio-paperless/commit/6425053c628359a398d973d9d7a0fd105a693499))
* **theme:** restore light mode and animate settings selectors ([#20](https://github.com/Kirari04/folio-paperless/issues/20)) ([c0c1381](https://github.com/Kirari04/folio-paperless/commit/c0c138165f7ec59bfba652baa27d720a96413720))
* **workflows:** verify owner and permission mutations ([#17](https://github.com/Kirari04/folio-paperless/issues/17) [#19](https://github.com/Kirari04/folio-paperless/issues/19) [#23](https://github.com/Kirari04/folio-paperless/issues/23)) ([7915a52](https://github.com/Kirari04/folio-paperless/commit/7915a525c78789d779bd086daa49f76e820c76f4))

## [0.2.0](https://github.com/Kirari04/folio-paperless/compare/v0.1.0...v0.2.0) (2026-08-01)


### Features

* add verified GitHub release updates ([#10](https://github.com/Kirari04/folio-paperless/issues/10)) ([e0d031b](https://github.com/Kirari04/folio-paperless/commit/e0d031bf10d962c2cb9bbe78705b398ae11f3a6f))
* ship verified updates and document workflow polish ([3a3a7f6](https://github.com/Kirari04/folio-paperless/commit/3a3a7f6e7c20772a44d6e5b6ec14135f5d3ec7b0))
* **ui:** add catalog quick-create ([8ca4874](https://github.com/Kirari04/folio-paperless/commit/8ca48746430fdf7f9c872c9ffea62801909089a1))
* **ui:** add document detail refresh ([4afa7e0](https://github.com/Kirari04/folio-paperless/commit/4afa7e0530152a3ad30d3b1b7cdff8cfd96760df))
* **ui:** polish document processing and metadata editing ([4b50f6d](https://github.com/Kirari04/folio-paperless/commit/4b50f6d6d73858e5e31e620358dc24805476b324))


### Bug Fixes

* **ci:** accept Android signer digest formats ([8e6e424](https://github.com/Kirari04/folio-paperless/commit/8e6e4244e3a4a9fb701a4fbb2b92501cdebdafc8))
* **ui:** gate document actions while processing ([8869031](https://github.com/Kirari04/folio-paperless/commit/8869031165b44ab96660d6fe5890055f0ee831ea))
* **ui:** smooth processed document handoff ([81d4d29](https://github.com/Kirari04/folio-paperless/commit/81d4d29c53ce6a3d52abee42561cbb48a11e7c49))

## 0.1.0 (2026-08-01)


### Features

* launch Folio for Paperless ([ac8e3b2](https://github.com/Kirari04/folio-paperless/commit/ac8e3b2513dc5c3df5e989c79248156dc4f9c0e8))


### Bug Fixes

* **ci:** honor forced manifest release versions ([deb60a2](https://github.com/Kirari04/folio-paperless/commit/deb60a2567186a8593f51937cbc3f497ad866e57))

## Changelog

Notable changes to Folio for Paperless are recorded here. This file is maintained by Release
Please from Conventional Commit pull-request titles.
