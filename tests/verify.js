// tests/verify.js: node tests for src/cutoverEngine.js, the same file the page loads. Run: node tests/verify.js
const E = require('../src/cutoverEngine.js');
const RAW = require('../data/catalog.json');

let pass = 0, fail = 0;
function sec(t) { console.log('\n' + t); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const fresh = (mut) => { const d = JSON.parse(JSON.stringify(RAW)); if (mut) mut(d); return E.newState(E.prepare(d).data); };
const ord = (s, id) => E.route(s).orders.find((x) => x.order.id === id);

sec('1. Data check: bad rows are skipped and reported, never a crash');
{
  const p = E.prepare(RAW);
  ok('sample data loads with no problems', p.problems.length === 0, p.problems);
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.items.push({ sku: '', name: 'No SKU', type: 'raw' });
  bad.items.push({ sku: 'X-1', name: 'Odd type', type: 'gadget' });
  bad.items.push({ sku: 'BB-1OIL', name: 'Exact duplicate', type: 'finished' });
  bad.orders.push({ id: 'F-30418', channel: 'Faire', retailer: 'Dup', date: '2026-10-26', status: 'open', lines: [{ sku: 'BB-1OIL', qty: 1 }] });
  bad.orders.push({ id: 'Z-1', channel: 'Etsy', retailer: 'Wrong channel', date: '2026-10-26', status: 'open', lines: [{ sku: 'BB-1OIL', qty: 1 }] });
  bad.orders.push({ id: 'Z-2', channel: 'Faire', retailer: 'Half qty', date: '2026-10-26', status: 'open', lines: [{ sku: 'BB-1OIL', qty: 1.5 }] });
  bad.recipes['NOPE'] = [{ sku: 'BOTTLE-250', qty: 1 }];
  delete bad.company.today;
  const q = E.prepare(bad);
  ok('an item with no SKU is skipped', q.problems.some((t) => /no SKU/.test(t)));
  ok('an item with an unknown type is skipped', q.problems.some((t) => /X-1.*finished or raw/.test(t)));
  ok('an exact duplicate SKU is skipped', q.problems.some((t) => /exact duplicate/.test(t)) && q.data.items.length === 28);
  ok('a duplicate order number is skipped', q.problems.some((t) => /duplicate order number/.test(t)));
  ok('an order from an unknown channel is skipped', q.problems.some((t) => /Z-1.*channel/.test(t)));
  ok('a fractional quantity is refused and the empty order skipped', q.problems.some((t) => /Z-2, line 1/.test(t)) && !q.data.orders.some((o) => o.id === 'Z-2'));
  ok('a recipe for an item that does not exist is skipped', q.problems.some((t) => /Recipe for NOPE/.test(t)));
  ok('a missing "today" falls back and says so', q.data.company.today === '2026-10-26' && q.problems.some((t) => /today/.test(t)));
}

sec('2. SKU clean-up rule');
{
  ok('"BB-1Oil", "bb-1oil" and " BB-1OIL " all clean to BB-1OIL', ['BB-1Oil', 'bb-1oil', ' BB-1OIL '].every((x) => E.cleanSku(x) === 'BB-1OIL'));
  ok('"BBQ SAUCE 12" and "BBQ_SAUCE-12" both clean to BBQ-SAUCE-12', E.cleanSku('BBQ SAUCE 12') === 'BBQ-SAUCE-12' && E.cleanSku('BBQ_SAUCE-12') === 'BBQ-SAUCE-12');
  ok('edit distance SMSALT-4OZ to SM-SALT-4OZ is 1', E.levenshtein('SMSALT-4OZ', 'SM-SALT-4OZ') === 1);
}

sec('3. The item audit');
{
  const s = fresh();
  const a = E.audit(s);
  ok('27 active items (the inactive 2024 gift box is left out)', a.active === 27 && a.rows.find((r) => r.item.sku === 'Gift-Box-3').skipped);
  ok('21 of 27 ready (78%)', a.ready === 21 && a.readinessPct === 78, a);
  ok('BBQ-SAUCE-12 and BBQ_SAUCE-12 are flagged as look-alikes', ['BBQ-SAUCE-12', 'BBQ_SAUCE-12'].every((k) => a.rows.find((r) => r.item.sku === k).issues.some((x) => x.code === 'collision')));
  ok('HONEY-12 has no unit, PEPPER-JAM-9 no recipe, GIFT-BOX-6 a missing ingredient (LABEL-GOLD)',
    a.rows.find((r) => r.item.sku === 'HONEY-12').issues.some((x) => x.code === 'missing_uom') &&
    a.rows.find((r) => r.item.sku === 'PEPPER-JAM-9').issues.some((x) => x.code === 'no_recipe') &&
    a.rows.find((r) => r.item.sku === 'GIFT-BOX-6').issues.some((x) => x.code === 'recipe_missing_component' && /LABEL-GOLD/.test(x.text)));
  ok('GIFT-BOX-3 is blocked only because the BBQ sauce in its recipe is not ready (knock-on)', a.rows.find((r) => r.item.sku === 'GIFT-BOX-3').issues.map((x) => x.code).join() === 'component_not_ready');
  ok('4 root problems behind 6 blocked items', a.rootFixes === 4 && a.blockedItems.length === 6, a.blockedItems);
  ok('a missing cost is a warning, not a blocker (RUB-STEAK-5 stays ready)', a.rows.find((r) => r.item.sku === 'RUB-STEAK-5').ready && a.warnings === 1);
  ok('items under their reorder point are noted (MAPLE-8OZ, MAPLE-BULK)', ['MAPLE-8OZ', 'MAPLE-BULK'].every((k) => a.rows.find((r) => r.item.sku === k).issues.some((x) => x.code === 'below_reorder')));
}

sec('4. Matching order lines the way Katana would');
{
  const s = fresh();
  const t = E.route(s).totals;
  ok('15 lines on 8 open orders', t.open === 8 && t.openLines === 15, t);
  ok('5 lines fail an exact match today', t.failAsIs === 5, t);
  ok('the clean-up rule rescues 2 of them on its own (bb-1oil, MAPLE-8oz)', t.autoFixed === 2, t);
  ok('3 need a decision: a look-alike and 2 unknown SKUs', t.needDecision === 3, t);
  ok('"BBQ SAUCE 12" is ambiguous between the two BBQ items', E.matchLine(s, 'BBQ SAUCE 12', 'cleaned').status === 'ambiguous');
  ok('SMSALT-4OZ gets a "did you mean SM-SALT-4OZ" suggestion', E.matchLine(s, 'SMSALT-4OZ', 'cleaned').suggestion === 'SM-SALT-4OZ');
  ok('CHILI-OIL-250 is too far from everything to guess', E.matchLine(s, 'CHILI-OIL-250', 'cleaned').suggestion === null);
  ok('an exact SKU still wins over the clean-up rule (BBQ_SAUCE-12 is the case pack)', E.matchLine(s, 'BBQ_SAUCE-12', 'cleaned').item.sku === 'BBQ_SAUCE-12');
}

sec('5. Routing every order at the switch');
{
  const s = fresh();
  const r = E.route(s);
  ok('all 8 open orders are blocked before any fix', r.totals.blocked === 8 && r.totals.katana === 0, r.totals);
  ok('the shipped order stays in history and the packed one finishes in SOS', ord(s, 'F-30412').route === 'done' && ord(s, 'F-30418').route === 'finish');
  ok('shipped and packed orders list no import reasons', ord(s, 'F-30412').reasons.length === 0 && ord(s, 'F-30418').reasons.length === 0);
  ok('2 open orders already invoiced in QuickBooks are guarded against double billing', r.totals.guarded === 2);
  ok('blocked order value is $1,704', r.totals.blockedValue === 1704, r.totals.blockedValue);
}

sec('6. Fixes, one at a time');
{
  const s = fresh();
  const r1 = E.renameItem(s, 'BBQ_SAUCE-12', 'BBQ-SAUCE-12-CS');
  ok('renaming the case pack clears the look-alike', r1.ok && !E.audit(s).rows.some((r) => r.issues.some((x) => x.code === 'collision')));
  ok('the old SKU is kept as an alias, so Derby Day\'s BBQ_SAUCE-12 still means the case pack', E.matchLine(s, 'BBQ_SAUCE-12', 'cleaned').item.sku === 'BBQ-SAUCE-12-CS');
  ok('the case-pack recipe follows the rename', !!s.recipes['BBQ-SAUCE-12-CS'] && !s.recipes['BBQ_SAUCE-12']);
  ok('GIFT-BOX-3 becomes ready with it (the knock-on clears)', E.audit(s).rows.find((r) => r.item.sku === 'GIFT-BOX-3').ready);
  ok('"BBQ SAUCE 12" now resolves to the single BBQ sauce', E.matchLine(s, 'BBQ SAUCE 12', 'cleaned').item.sku === 'BBQ-SAUCE-12');
  ok('M-77105 now moves as already invoiced', ord(s, 'M-77105').route === 'katana_invoiced');
  ok('a rename to a messy SKU is refused with the clean form', /clean form: BB-1OIL-V2/.test((E.renameItem(s, 'BB-1OIL', 'bb_1oil-v2').problems || []).join()));
  ok('a rename that looks like another item is refused with a reason', /look identical to BB-1OIL/.test((E.renameItem(s, 'SB-1OIL', 'BB-1OIL').problems || []).join()));
  ok('a unit outside the list is refused', !E.setUom(s, 'HONEY-12', 'bottle').ok);
  ok('setting HONEY-12 to "ea" readies it', E.setUom(s, 'HONEY-12', 'ea').ok && E.audit(s).rows.find((r) => r.item.sku === 'HONEY-12').ready);
  ok('the pepper jam recipe comes in from the recipe sheet', E.addRecipeFromSheet(s, 'PEPPER-JAM-9').ok && E.audit(s).rows.find((r) => r.item.sku === 'PEPPER-JAM-9').ready);
  ok('a recipe the sheet does not have is refused', !E.addRecipeFromSheet(s, 'HONEY-12').ok);
  ok('dropping LABEL-GOLD from the Grand Gift Box readies it', E.removeComponent(s, 'GIFT-BOX-6', 'LABEL-GOLD').ok && E.audit(s).ready === 27);
  ok('accepting the suggestion maps SMSALT-4OZ', E.mapAlias(s, 'SMSALT-4OZ', 'SM-SALT-4OZ').ok && E.matchLine(s, 'SMSALT-4OZ', 'cleaned').status === 'alias');
  ok('mapping to an item that does not exist is refused', !E.mapAlias(s, 'CHILI-OIL-250', 'NOT-A-SKU').ok);
  E.mapAlias(s, 'CHILI-OIL-250', 'SB-1OIL');
  const t = E.route(s).totals;
  ok('after 6 fixes all 8 open orders move: 6 to Katana, 2 marked already invoiced', t.blocked === 0 && t.katana === 6 && t.katanaInvoiced === 2, t);
  ok('the fix log records each step', s.log.length === 6);
}

sec('7. Adding an order');
{
  const s = fresh();
  ok('a missing retailer, a bad channel and a zero quantity are all refused', E.addOrder(s, { retailer: '', channel: 'Etsy', sku: 'BB-1OIL', qty: 0 }).problems.length === 3);
  const r = E.addOrder(s, { retailer: 'Paducah Provisions', channel: 'Faire', sku: 'Sm-Salt 4oz', qty: 24, price: 4.5 });
  ok('a new Faire order gets the next F- number', r.ok && r.order.id === 'F-77127', r.order && r.order.id);
  ok('its messy SKU "Sm-Salt 4oz" resolves through the clean-up rule', E.matchLine(s, 'Sm-Salt 4oz', 'cleaned').status === 'variant');
  ok('it routes to Katana (the item is ready)', ord(s, 'F-77127').route === 'katana');
}

sec('8. The dated plan');
{
  const s = fresh();
  const p = E.plan(s);
  ok('default switch is Mon 9 Nov, 10 business days away', p.ok && p.cutover === '2026-11-09' && p.businessDaysAway === 10, p.businessDaysAway);
  ok('9 dated tasks from Mon 2 Nov to Tue 17 Nov', p.tasks.length === 9 && p.tasks[0].date === '2026-11-02' && p.tasks[8].date === '2026-11-17');
  ok('the freeze lands 2 business days before the switch (Thu 5 Nov)', p.tasks.find((t) => t.phase === 'Freeze').date === '2026-11-05');
  ok('the first task names the root problems', /4 root problems/.test(p.tasks[0].title) && /look-alike SKUs/.test(p.tasks[0].title));
  ok('a Saturday switch is refused', /weekend or holiday/.test(E.checkCutover(s, '2026-11-07').join()));
  ok('Thanksgiving is refused as a holiday', /weekend or holiday/.test(E.checkCutover(s, '2026-11-26').join()));
  ok('a switch this week is refused as too soon (earliest Mon 2 Nov)', /Too soon/.test(E.checkCutover(s, '2026-10-29').join()) && E.earliestCutover(s) === '2026-11-02');
  ok('business days skip Thanksgiving and the Friday after', E.addBusinessDays('2026-11-25', 1, s.rules.holidays) === '2026-11-30');
  const s2 = fresh();
  E.setRules(s2, { prepDays: 8, freezeDays: 3, parallelDays: 5 });
  ok('8 preparation days move the earliest switch to Thu 5 Nov', E.earliestCutover(s2) === '2026-11-05');
  ok('so a Wed 4 Nov switch is refused and Mon 9 Nov still works', !E.plan(s2, '2026-11-04').ok && E.plan(s2, '2026-11-09').ok);
  ok('a freeze longer than the preparation window is refused', !E.setRules(s2, { prepDays: 4, freezeDays: 5 }).ok);
}

sec('9. Exports');
{
  const s = fresh();
  const csv = E.planCsv(E.plan(s));
  ok('plan CSV has a header and 9 tasks', csv.split('\n').length === 10 && /^Date,Phase,Task,Owner/.test(csv));
  ok('fields with commas are quoted', /"Fix the 4 root problems \(look-alike SKUs, /.test(csv));
  const issues = E.issuesCsv(E.audit(s));
  ok('issues CSV lists every active item problem', issues.split('\n').length - 1 === E.audit(s).rows.filter((r) => !r.skipped).reduce((n, r) => n + r.issues.length, 0));
}

console.log('\n' + (pass + fail) + ' checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
