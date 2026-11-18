# Report template

```markdown
## Expo review: <app name> (SDK <n>, <managed/CNG | bare>)

ExpoPulse 0.2.0: <N> findings (<e> error, <w> warning, <i> info), score <s>/100.
Layers not applicable: <ios/android/...>. Notes: <app.config.ts not evaluated, pnpm sizes under-reported, …>

### Release blockers (<count>)
1. **<rule>**: <file:line>. <what breaks: store rejection / build failure / crash>.
   Fix: <exact change, where (app.json vs native)>. Confirmed | Likely.

### Store-review risk (<count>)
- **<rule>**: <evidence>. Reviewer will <ask/reject because…>. Fix: <…>.

### Size (≈<total> estimated, unmeasured)
| Item | Est. saving | Fix | Auto-fixable |
|---|---|---|---|

### Runtime performance
- <screen/list>: <rule>, <evidence>, <fix>.

### Hygiene
<rule>: <count> · <rule>: <count> · …

### Proposed next steps
1. <cheapest blocker fix> (needs approval)
2. `expopulse fix --rule <ids>`: <what it will delete or change> (needs approval)
3. Measure: build AAB/IPA before and after to confirm size savings.
```

**Short form** (when asked for brevity): the blockers as a list, then one line each for size, performance and hygiene, then the single next step.
