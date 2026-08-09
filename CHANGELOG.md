# [0.5.0](https://github.com/AlixAkhribi/mcp-whoop/compare/v0.4.0...v0.5.0) (2026-08-09)


### Bug Fixes

* state public access so npm will attest the first publish ([3182ae2](https://github.com/AlixAkhribi/mcp-whoop/commit/3182ae2491b6ccc430bfe363ee0eebd3c38a40f4))


### Features

* log server activity to stderr with a configurable level ([17cf8c5](https://github.com/AlixAkhribi/mcp-whoop/commit/17cf8c50724a719769043168576fb635f2d5ac62))
* scope the environment gate to the command being run ([edd845e](https://github.com/AlixAkhribi/mcp-whoop/commit/edd845ede2bb52116ed74c423717003c5ab7b16e))

# [0.4.0](https://github.com/AlixAkhribi/mcp-whoop/compare/v0.3.0...v0.4.0) (2026-08-09)


### Bug Fixes

* reject timeouts Node's timers cannot honor ([b9405d1](https://github.com/AlixAkhribi/mcp-whoop/commit/b9405d155bbd96ffd602b9973fc34ed9846cf0f0))


### Features

* validate the WHOOP_* environment at startup ([a6759a0](https://github.com/AlixAkhribi/mcp-whoop/commit/a6759a0c9b054a710c52f6a303db4ff651647835))

# [0.3.0](https://github.com/AlixAkhribi/mcp-whoop/compare/v0.2.0...v0.3.0) (2026-08-06)


### Bug Fixes

* bound and sanitize every WHOOP request ([d944cb8](https://github.com/AlixAkhribi/mcp-whoop/commit/d944cb88b5e8c58d4601b4813db4ff38d7895508))
* refresh an expired login before revoking it ([4f4f97e](https://github.com/AlixAkhribi/mcp-whoop/commit/4f4f97ef13b6f566c719aebf8572bc70f4da4d8f))


### Features

* declare every tool read-only and refuse unknown arguments ([b5dad83](https://github.com/AlixAkhribi/mcp-whoop/commit/b5dad8349d1c7069b5595c002235637ad79e0da0))
* pin the tools/list order and cache hints ([432c749](https://github.com/AlixAkhribi/mcp-whoop/commit/432c749b90ae8a6778a1c7684c09d0d7bfcde781))
* read WHOOP cycles, recoveries, sleeps and workouts ([e70f50f](https://github.com/AlixAkhribi/mcp-whoop/commit/e70f50f39e2d23f6ec00bb60f759269bec7d8eff))
* summarize sleep, recovery and today in one call ([dcd07b8](https://github.com/AlixAkhribi/mcp-whoop/commit/dcd07b82ed1866ac926f96f53312850a712f5561))

# [0.2.0](https://github.com/AlixAkhribi/mcp-whoop/compare/v0.1.0...v0.2.0) (2026-08-05)


### Features

* build the whoop api client foundation ([c33bc0b](https://github.com/AlixAkhribi/mcp-whoop/commit/c33bc0b137ea4c7b98ff6104b832762b18725d36))
* log in and out of whoop from the command line ([a6f7a90](https://github.com/AlixAkhribi/mcp-whoop/commit/a6f7a90a1acb2c24d744ce321ccba1cf9858734e))
* persist and refresh whoop tokens safely across processes ([9808682](https://github.com/AlixAkhribi/mcp-whoop/commit/9808682a3187219a892adb061551a02b5ba5c046))
* redact token material from every outward surface ([e2faf09](https://github.com/AlixAkhribi/mcp-whoop/commit/e2faf09d1e8f05e576b51704b7479c1590af72bf))
* serve whoop data tools gated on granted scopes ([d1d8a21](https://github.com/AlixAkhribi/mcp-whoop/commit/d1d8a2184c055f41e5429c35982a2e21cc8eea93))

# [0.1.0](https://github.com/AlixAkhribi/mcp-whoop/compare/v0.0.0...v0.1.0) (2026-08-01)


### Features

* add the stdio mcp server with a hello tool ([76553d7](https://github.com/AlixAkhribi/mcp-whoop/commit/76553d76d3bd6fc51826186021bfe345b9f4e7d2))
