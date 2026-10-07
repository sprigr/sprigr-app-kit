# @sprigr/apps-home

The Sprigr Home contracts for marketplace apps: what an app imports to feed
the Sprigr Home (sprigr-team decisions 0170 to 0174, 0177 and 0178).

- **Types** for the five platform-owned contracts (`sprigr/home_schedule`,
  `sprigr/home_queue`, `sprigr/home_metrics`, `sprigr/home_subject_facts`,
  `sprigr/home_identity`), the request a Home tool receives as `args._home`
  (`HomeRequest`), and the answer it returns (`HomeResult`).
- **`validateHome(manifest, deps)`**: the manifest `home` block validator,
  the same one the platform runs at publish and on read.
- **`validateHomeFixtures(block, readFile)`**: the fixture-file check (states,
  the display-text rules, no record the platform would drop).
- **`checkHomeAnswer(contract, answer, ctx)`**: the answer validator the
  platform runs before caching.
- **`homeDisplayText(text, max)`**: cleans vendor text (titles, locations) to
  the Home display rules, so a record is not dropped for a "!" or a link.

## Same code as the platform

Every file under `src/` except `index.ts` (one extra export) and `display.ts`
is a verbatim copy of sprigr-team `packages/shared/src/home-contracts/` at
`6bc9adf34`. That directory imports nothing from outside itself so it can be
published unchanged. To update this package, copy the directory again and
bump the version: the platform and the apps must agree on every rule.

## Use

```ts
import { checkHomeAnswer, homeDisplayText, type HomeRequest, type HomeResult, type ScheduleRecord } from '@sprigr/apps-home';

export default {
  get_my_app_home: async (args: { _home?: HomeRequest }) => {
    const req = args._home!; // set by the platform wrapper on a Home dispatch only
    const result: HomeResult<ScheduleRecord> = {
      v: '1.0.0', state: 'empty', as_of: new Date().toISOString(),
      basis: { day: req.basis.day, tz: req.basis.tz }, records: [],
    };
    return result;
  },
};
```

`validateHome` needs the platform's dispatch classifier passed in
(`{ isReadShapedDispatch }`), because that rule lives in the platform; a test
can pass `(name, effects) => effects !== 'write' && /^(get|list|search)_/.test(name)`.
