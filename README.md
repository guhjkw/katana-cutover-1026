# Katana cutover planner (live demo)

A working planner for a wholesale brand moving from **SOS Inventory to Katana**, with Faire and MarketTime orders arriving through **Syncware** and invoices in **QuickBooks Online**. It shows what would break if you switched today, ranks the fixes, guards against double billing, and builds a dated cutover plan. The company and all data are invented.

## Try it
Open `index.html` (works off disk too) and:
- Fix the look-alike SKUs, the missing unit, the missing recipe and the missing ingredient, then map the two unknown channel SKUs. Watch "Open orders that move" go from 0 of 8 to 8 of 8.
- Try to break it: a Saturday switch, a date this week, renaming the case pack to `bbq sauce 12`, or a new order with SKU `Sm-Salt 4oz`.

## Files
```
index.src.html            page source (build.py embeds the data for file://)
index.html                built page
src/cutoverEngine.js      the planner: clean-up, audit, routing, plan, fixes
data/catalog.json         invented items, recipes, recipe sheet and orders
tests/verify.js           68 logic checks (node)
tests/test-output.txt     the saved passing run
tests/browser-check.py    30 checks driving the real page (Playwright)
```
The page and the tests load the same `src/cutoverEngine.js`.

## Run the tests
```
node tests/verify.js             # 68 checks: 68 passed, 0 failed
python3 build.py                 # rebuild index.html after editing index.src.html or the data
python3 tests/browser-check.py   # 30 browser checks: 30 passed, 0 failed
```

## How the logic works
| Step | Rule |
|---|---|
| Clean-up | Trim, spaces/underscores/slashes to one hyphen, upper-case. `BB-1Oil`, `bb-1oil` → `BB-1OIL` |
| Look-alikes | Two active items that clean to the same SKU block each other until one is renamed |
| Item audit | Blockers: no unit, finished product without a recipe, recipe ingredient not on the list. Warnings: no cost. Notes: below reorder point |
| Knock-on | A product whose recipe uses a blocked item is blocked too, and clears when that item is fixed |
| Line matching | Alias first, then exact SKU, then the clean-up rule, then a "did you mean" within edit distance 2 (only if clearly closest) |
| Routing | Shipped stays in history, packed finishes in SOS, open moves to Katana; open orders already invoiced in QuickBooks move marked as invoiced |
| Renames | New SKUs must be in the clean form; the old SKU stays as an alias so existing channel listings keep mapping |
| Plan | Business days only (weekends and US holidays skipped): prep, freeze, switch, parallel week, SOS read-only |

## Extend it
Rules (`prepDays`, `freezeDays`, `parallelDays`, units, holidays) live in `data/catalog.json` and can be changed on the page. Add a check by adding an entry to `ISSUE` and a line in `audit()`.

## What the delivered version adds
Reads the real SOS export and recipe sheet, imports items, recipes and open orders through Katana's API, points Syncware at Katana, checks QuickBooks and ShipStation, runs the parallel week, and leaves a written report.

Built by Taiwo, Pathfinder Automation Solutions.
