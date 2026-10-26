// src/cutoverEngine.js: the logic behind the Katana cutover planner.
// The page and the node tests load this same file. Nothing on the page is scripted:
// every number comes from these functions running on the data you see.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cutover = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = ['finished', 'raw'];
  const STATUSES = ['open', 'packed', 'shipped'];
  const DAY = 86400000;

  // Plain-English text for every issue the audit can raise. "blocker" stops the item (and any
  // order that uses it) from importing; "warn" imports but needs a decision; "info" is context.
  const ISSUE = {
    collision: { level: 'blocker', short: 'look-alike SKUs', text: 'Looks identical to another item once SKUs are cleaned up' },
    missing_uom: { level: 'blocker', short: 'missing unit', text: 'No unit of measure (Katana needs one)' },
    no_recipe: { level: 'blocker', short: 'missing recipe', text: 'Finished product with no recipe, so Katana cannot plan making it' },
    recipe_missing_component: { level: 'blocker', short: 'missing ingredient', text: 'Recipe uses an ingredient that is not on the item list' },
    component_not_ready: { level: 'blocker', short: 'waiting on another item', text: 'Uses something that is not ready yet' },
    missing_cost: { level: 'warn', short: 'missing cost', text: 'No cost, so profit per order will read wrong' },
    below_reorder: { level: 'info', short: 'below reorder point', text: 'Below its reorder point: Katana will suggest buying or making on day one' },
    inactive: { level: 'info', short: 'inactive', text: 'Inactive in SOS: left out of the import' }
  };

  // ---------- helpers ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (d) => d.toISOString().slice(0, 10);

  function isBusinessDay(dateStr, holidays) {
    const wd = toDate(dateStr).getUTCDay();
    return wd !== 0 && wd !== 6 && !(holidays || []).includes(dateStr);
  }
  // Move n business days from a date (n can be negative). Weekends and listed holidays are skipped.
  function addBusinessDays(dateStr, n, holidays) {
    let d = toDate(dateStr);
    const step = n < 0 ? -1 : 1;
    let left = Math.abs(n);
    while (left > 0) {
      d = new Date(d.getTime() + step * DAY);
      if (isBusinessDay(fmt(d), holidays)) left--;
    }
    return fmt(d);
  }
  // Business days strictly after `a` up to and including `b`.
  function businessDaysBetween(a, b, holidays) {
    if (b <= a) return 0;
    let n = 0, d = toDate(a);
    while (fmt(d) < b) { d = new Date(d.getTime() + DAY); if (isBusinessDay(fmt(d), holidays)) n++; }
    return n;
  }
  function nice(dateStr) {
    const d = toDate(dateStr);
    return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // ---------- SKU clean-up ----------
  // The clean-up rule: trim, turn spaces/underscores/slashes into one hyphen, upper-case.
  // "BB-1Oil", "bb-1oil" and " BB-1OIL " all become "BB-1OIL"; "BBQ SAUCE 12" becomes "BBQ-SAUCE-12".
  function cleanSku(raw) {
    if (raw == null) return '';
    return String(raw).trim().replace(/[\s_\/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
  }
  // Edit distance, for "did you mean" suggestions on SKUs that match nothing.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[m][n];
  }

  // ---------- data check: bad rows are skipped and reported, never a crash ----------
  function prepare(raw) {
    const problems = [];
    const src = raw || {};
    const company = Object.assign({ name: 'Your company', channels: ['Faire', 'MarketTime'] }, src.company || {});
    const rules = Object.assign({ prepDays: 5, freezeDays: 2, parallelDays: 5, defaultCutover: null, uoms: ['ea', 'case', 'L', 'kg'], holidays: [] }, src.rules || {});
    if (!isDate(company.today)) { problems.push('No valid "today" date in the data, so 2026-10-26 is used.'); company.today = '2026-10-26'; }

    const items = [];
    const seenExact = new Set();
    (src.items || []).forEach((it, i) => {
      const row = 'Item row ' + (i + 1);
      if (!it || typeof it.sku !== 'string' || !it.sku.trim()) return problems.push(row + ': no SKU, skipped.');
      if (!it.name) return problems.push(row + ' (' + it.sku + '): no name, skipped.');
      if (!TYPES.includes(it.type)) return problems.push(row + ' (' + it.sku + '): type must be finished or raw, skipped.');
      if (seenExact.has(it.sku.trim())) return problems.push(row + ' (' + it.sku + '): exact duplicate SKU, skipped.');
      if (it.onHand != null && (typeof it.onHand !== 'number' || it.onHand < 0)) return problems.push(row + ' (' + it.sku + '): on-hand must be a number of 0 or more, skipped.');
      seenExact.add(it.sku.trim());
      items.push({
        sku: it.sku.trim(), name: String(it.name), type: it.type, uom: (it.uom || '').trim(),
        onHand: it.onHand == null ? 0 : it.onHand, reorderPoint: typeof it.reorderPoint === 'number' ? it.reorderPoint : 0,
        cost: typeof it.cost === 'number' ? it.cost : null, active: it.active !== false
      });
    });

    const skus = new Set(items.map((x) => x.sku));
    const recipes = {};
    Object.keys(src.recipes || {}).forEach((fg) => {
      if (!skus.has(fg)) return problems.push('Recipe for ' + fg + ': no such item, skipped.');
      const comps = (src.recipes[fg] || []).filter((c, j) => {
        const ok = c && typeof c.sku === 'string' && c.sku && typeof c.qty === 'number' && c.qty > 0;
        if (!ok) problems.push('Recipe for ' + fg + ', line ' + (j + 1) + ': needs an ingredient SKU and a quantity above 0, skipped.');
        return ok;
      });
      recipes[fg] = comps.map((c) => ({ sku: c.sku, qty: c.qty }));
    });

    const orders = [];
    const seenOrders = new Set();
    (src.orders || []).forEach((o, i) => {
      const row = 'Order row ' + (i + 1);
      if (!o || !o.id) return problems.push(row + ': no order number, skipped.');
      if (seenOrders.has(o.id)) return problems.push(row + ' (' + o.id + '): duplicate order number, skipped.');
      if (!company.channels.includes(o.channel)) return problems.push(row + ' (' + o.id + '): channel must be one of ' + company.channels.join(', ') + ', skipped.');
      if (!STATUSES.includes(o.status)) return problems.push(row + ' (' + o.id + '): status must be open, packed or shipped, skipped.');
      if (!isDate(o.date)) return problems.push(row + ' (' + o.id + '): no valid order date, skipped.');
      const lines = (o.lines || []).filter((l, j) => {
        const ok = l && typeof l.sku === 'string' && l.sku.trim() && Number.isInteger(l.qty) && l.qty > 0;
        if (!ok) problems.push(o.id + ', line ' + (j + 1) + ': needs a SKU and a whole quantity above 0, skipped.');
        return ok;
      });
      if (!lines.length) return problems.push(row + ' (' + o.id + '): no usable lines, skipped.');
      seenOrders.add(o.id);
      orders.push({ id: o.id, channel: o.channel, retailer: String(o.retailer || 'Unknown retailer'), date: o.date, status: o.status, qboInvoice: o.qboInvoice || null,
        lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, price: typeof l.price === 'number' ? l.price : 0 })) });
    });

    return { data: { company, rules, items, recipes, orders, recipeSheet: src.recipeSheet || {} }, problems };
  }

  function newState(data) {
    const d = clone(data);
    return {
      company: d.company, rules: d.rules, items: d.items, recipes: d.recipes, orders: d.orders,
      recipeSheet: d.recipeSheet || {}, aliases: {}, log: [],
      cutover: d.rules.defaultCutover || addBusinessDays(d.company.today, (d.rules.prepDays || 5) + 5, d.rules.holidays)
    };
  }

  // ---------- the audit ----------
  function activeItems(state) { return state.items.filter((x) => x.active); }
  function cleanIndex(state) {
    const idx = {};
    activeItems(state).forEach((it) => { const c = cleanSku(it.sku); (idx[c] = idx[c] || []).push(it); });
    return idx;
  }

  function audit(state) {
    const idx = cleanIndex(state);
    const known = new Set(activeItems(state).map((x) => x.sku));
    const rows = state.items.map((it) => {
      const issues = [];
      const add = (code, detail) => issues.push({ code, level: ISSUE[code].level, text: ISSUE[code].text + (detail ? ': ' + detail : '') });
      if (!it.active) { add('inactive'); return { item: it, clean: cleanSku(it.sku), issues, ready: false, skipped: true }; }
      const twins = idx[cleanSku(it.sku)].filter((x) => x !== it);
      if (twins.length) add('collision', twins.map((x) => x.sku + ' (' + x.name + ')').join(', '));
      if (!it.uom) add('missing_uom');
      if (it.type === 'finished') {
        const rec = state.recipes[it.sku];
        if (!rec || !rec.length) add('no_recipe');
        else {
          const missing = rec.filter((c) => !known.has(c.sku)).map((c) => c.sku);
          if (missing.length) add('recipe_missing_component', missing.join(', '));
        }
      }
      if (it.cost == null) add('missing_cost');
      if (it.onHand < it.reorderPoint) add('below_reorder', it.onHand + ' on hand, reorder at ' + it.reorderPoint);
      return { item: it, clean: cleanSku(it.sku), issues, ready: !issues.some((x) => x.level === 'blocker'), skipped: false };
    });
    // A finished product can only import if everything in its recipe imports too, so readiness
    // cascades: fix the BBQ sauce and the gift boxes that contain it become ready with it.
    const bySku = {};
    rows.forEach((r) => { bySku[r.item.sku] = r; });
    let changed = true;
    while (changed) {
      changed = false;
      rows.forEach((r) => {
        if (r.skipped || r.item.type !== 'finished' || r.issues.some((x) => x.code === 'component_not_ready')) return;
        const waiting = (state.recipes[r.item.sku] || []).filter((c) => bySku[c.sku] && !bySku[c.sku].skipped && !bySku[c.sku].ready).map((c) => c.sku);
        if (waiting.length) {
          r.issues.push({ code: 'component_not_ready', level: 'blocker', text: ISSUE.component_not_ready.text + ': ' + waiting.join(', ') });
          r.ready = false;
          changed = true;
        }
      });
    }
    const active = rows.filter((r) => !r.skipped);
    const ready = active.filter((r) => r.ready);
    // Root fixes: what someone actually has to do. A collision pair is one fix; knock-on blocks are not fixes.
    const collisionGroups = new Set(active.filter((r) => r.issues.some((x) => x.code === 'collision')).map((r) => r.clean));
    const rootFixes = collisionGroups.size + active.reduce((n, r) => n + r.issues.filter((x) => x.level === 'blocker' && x.code !== 'collision' && x.code !== 'component_not_ready').length, 0);
    const count = (lvl) => active.reduce((n, r) => n + r.issues.filter((x) => x.level === lvl).length, 0);
    const byCode = {};
    active.forEach((r) => r.issues.forEach((x) => { byCode[x.code] = (byCode[x.code] || 0) + 1; }));
    return {
      rows, byCode,
      active: active.length, ready: ready.length,
      readinessPct: active.length ? Math.round((ready.length / active.length) * 100) : 0,
      blockers: count('blocker'), warnings: count('warn'), rootFixes,
      blockedItems: active.filter((r) => !r.ready).map((r) => r.item.sku),
      recipes: Object.keys(state.recipes).filter((fg) => ready.some((r) => r.item.sku === fg)).length
    };
  }

  // ---------- matching an order line to an item ----------
  // mode "exact": what Katana does today with no clean-up, exact text match only.
  // mode "cleaned": aliases first, then exact, then the clean-up rule, then a suggestion.
  function matchLine(state, rawSku, mode, auditResult) {
    const raw = String(rawSku).trim();
    const actives = activeItems(state);
    const a = auditResult || audit(state);
    const readyOf = (it) => { const r = a.rows.find((x) => x.item === it); return !!(r && r.ready); };
    const exact = actives.find((x) => x.sku === raw);
    if (mode === 'exact') return exact ? { status: 'match', item: exact, ready: readyOf(exact) } : { status: 'orphan' };

    if (state.aliases[raw]) {
      const t = actives.find((x) => x.sku === state.aliases[raw]);
      if (t) return { status: 'alias', item: t, ready: readyOf(t) };
    }
    if (exact) return { status: 'match', item: exact, ready: readyOf(exact) };
    const hits = cleanIndex(state)[cleanSku(raw)] || [];
    if (hits.length === 1) return { status: 'variant', item: hits[0], ready: readyOf(hits[0]) };
    if (hits.length > 1) return { status: 'ambiguous', candidates: hits.map((x) => x.sku) };
    // Nothing matched: suggest the closest cleaned SKU, but only if it is clearly the closest.
    const c = cleanSku(raw);
    const scored = actives.map((x) => ({ sku: x.sku, d: levenshtein(c, cleanSku(x.sku)) })).sort((p, q) => p.d - q.d);
    const best = scored[0];
    const suggestion = best && best.d <= 2 && !(scored[1] && scored[1].d === best.d) ? best.sku : null;
    return { status: 'orphan', suggestion };
  }

  // ---------- routing every order at the cutover ----------
  function route(state, cutoverDate) {
    const cut = cutoverDate || state.cutover;
    const a = audit(state);
    const out = state.orders.map((o) => {
      const lines = o.lines.map((l) => Object.assign({}, l, { exact: matchLine(state, l.sku, 'exact', a), m: matchLine(state, l.sku, 'cleaned', a) }));
      const reasons = [];
      // Only orders that will import into Katana need their lines to resolve.
      if (o.status === 'open') lines.forEach((l) => {
        if (l.m.status === 'orphan') reasons.push(l.sku + ' matches no item' + (l.m.suggestion ? ' (did you mean ' + l.m.suggestion + '?)' : ''));
        else if (l.m.status === 'ambiguous') reasons.push(l.sku + ' could be ' + l.m.candidates.join(' or '));
        else if (!l.m.ready) reasons.push(l.m.item.sku + ' is not ready to import');
      });
      const value = o.lines.reduce((s, l) => s + l.qty * l.price, 0);
      let r, text;
      if (o.status === 'shipped') { r = 'done'; text = 'Shipped: stays in SOS and QuickBooks history'; }
      else if (o.status === 'packed') { r = 'finish'; text = 'Packed: ship it from SOS before the switch (already invoiced in QuickBooks)'; }
      else if (o.date > cut) { r = reasons.length ? 'blocked' : 'direct'; text = reasons.length ? 'Arrives after the switch but cannot import yet' : 'Arrives straight into Katana'; }
      else if (reasons.length) { r = 'blocked'; text = 'Cannot import until fixed'; }
      else if (o.qboInvoice) { r = 'katana_invoiced'; text = 'Moves to Katana marked as already invoiced (' + o.qboInvoice + '), so QuickBooks is not billed twice'; }
      else { r = 'katana'; text = 'Moves to Katana; Katana creates the QuickBooks invoice when it is packed'; }
      return { order: o, lines, reasons, route: r, text, value, guarded: o.status === 'open' && !!o.qboInvoice };
    });
    const live = out.filter((x) => x.order.status === 'open');
    const liveLines = live.reduce((acc, x) => acc.concat(x.lines), []);
    const count = (r) => out.filter((x) => x.route === r).length;
    return {
      cutover: cut, orders: out,
      totals: {
        open: live.length, katana: count('katana'), katanaInvoiced: count('katana_invoiced'), direct: count('direct'),
        blocked: count('blocked'), finish: count('finish'), done: count('done'),
        guarded: out.filter((x) => x.guarded).length,
        openLines: liveLines.length,
        // Exact text match, the way Katana matches SKUs with no clean-up.
        failAsIs: liveLines.filter((l) => l.exact.status !== 'match').length,
        // Of those, how many the clean-up rule or an alias rescues on its own.
        autoFixed: liveLines.filter((l) => l.exact.status !== 'match' && (l.m.status === 'variant' || l.m.status === 'alias')).length,
        // Still unmatched after clean-up: needs a person to decide.
        needDecision: liveLines.filter((l) => l.m.status === 'orphan' || l.m.status === 'ambiguous').length,
        // Matched, but the item itself is not ready to import yet.
        waitingOnItems: liveLines.filter((l) => (l.m.status === 'match' || l.m.status === 'variant' || l.m.status === 'alias') && !l.m.ready).length,
        blockedValue: out.filter((x) => x.route === 'blocked').reduce((s, x) => s + x.value, 0)
      }
    };
  }

  // ---------- the dated cutover plan ----------
  function earliestCutover(state) {
    let d = addBusinessDays(state.company.today, state.rules.prepDays, state.rules.holidays);
    return d;
  }
  function checkCutover(state, dateStr) {
    const problems = [];
    if (!isDate(dateStr)) return ['Pick a valid date.'];
    if (!isBusinessDay(dateStr, state.rules.holidays)) problems.push(nice(dateStr) + ' is a weekend or holiday. Switch on a business day so someone is there for the first orders.');
    const early = earliestCutover(state);
    if (dateStr < early) problems.push('Too soon: the plan needs ' + state.rules.prepDays + ' business days of preparation. The earliest switch is ' + nice(early) + '.');
    return problems;
  }

  function plan(state, cutoverDate) {
    const cut = cutoverDate || state.cutover;
    const problems = checkCutover(state, cut);
    if (problems.length) return { ok: false, problems, tasks: [] };
    const R = state.rules, H = R.holidays;
    const a = audit(state);
    const rt = route(state, cut);
    const kinds = Object.keys(a.byCode).filter((k) => ISSUE[k].level === 'blocker' && k !== 'component_not_ready').map((k) => ISSUE[k].short);
    const at = (n) => addBusinessDays(cut, n, H);
    const tasks = [
      { offset: -R.prepDays, phase: 'Prepare', title: a.rootFixes ? 'Fix the ' + a.rootFixes + ' root problem' + (a.rootFixes === 1 ? '' : 's') + ' (' + kinds.join(', ') + ') that block ' + (a.active - a.ready) + ' items' : 'No blockers left: confirm the item list with you', owner: 'Taiwo + you' },
      { offset: -Math.max(R.freezeDays + 2, 3), phase: 'Prepare', title: 'Import ' + a.ready + ' ready items and ' + a.recipes + ' recipes into a Katana test copy; compare counts with SOS', owner: 'Taiwo' },
      { offset: -Math.max(R.freezeDays + 1, 2), phase: 'Prepare', title: 'Point Syncware at the Katana test copy for ' + state.company.channels.join(' and ') + '; send copies of 3 real orders through', owner: 'Taiwo' },
      { offset: -R.freezeDays, phase: 'Freeze', title: 'Freeze: no new items or recipes in SOS until the switch', owner: 'You' },
      { offset: -1, phase: 'Freeze', title: 'Export ' + rt.totals.open + ' open orders; mark ' + rt.totals.guarded + ' already invoiced in QuickBooks so they are not billed twice', owner: 'Taiwo' },
      { offset: 0, phase: 'Switch', title: 'Switch Syncware to Katana and turn off the QuickBooks → SOS sync. First real orders land in Katana', owner: 'Taiwo, with you on a call' },
      { offset: 1, phase: 'Parallel', title: 'Parallel check starts: every new order appears once in Katana and once in QuickBooks; labels come from ShipStation', owner: 'Taiwo' },
      { offset: R.parallelDays, phase: 'Parallel', title: 'Parallel check ends: sign-off when ' + R.parallelDays + ' business days run clean', owner: 'You' },
      { offset: R.parallelDays + 1, phase: 'Done', title: 'SOS becomes read-only and stays for history', owner: 'You' }
    ].map((t) => Object.assign(t, { date: at(t.offset), nice: nice(at(t.offset)) }))
      .sort((p, q) => p.offset - q.offset);
    return { ok: true, problems: [], tasks, cutover: cut, businessDaysAway: businessDaysBetween(state.company.today, cut, H) };
  }

  // ---------- fixes (each one re-runs everything above) ----------
  function findItem(state, sku) { return state.items.find((x) => x.sku === sku); }

  // Rename an item. The old SKU is kept as an alias so channel listings that still use it keep mapping.
  function renameItem(state, sku, newSku) {
    const it = findItem(state, sku);
    const ns = (newSku || '').trim();
    if (!it) return { ok: false, problems: ['No item ' + sku + '.'] };
    if (!ns) return { ok: false, problems: ['Type the new SKU.'] };
    if (ns === sku) return { ok: false, problems: ['That is the same SKU.'] };
    // New SKUs follow the clean form, so the mess is not re-created.
    if (ns !== cleanSku(ns)) return { ok: false, problems: ['Use the clean form: ' + cleanSku(ns) + ' (capitals, hyphens, no spaces).'] };
    const clash = activeItems(state).find((x) => x !== it && cleanSku(x.sku) === cleanSku(ns));
    if (clash) return { ok: false, problems: [ns + ' would look identical to ' + clash.sku + '. Pick something clearly different, for example ' + cleanSku(ns) + '-CS.'] };
    // Recipes keyed by or using the old SKU follow the rename.
    if (state.recipes[sku]) { state.recipes[ns] = state.recipes[sku]; delete state.recipes[sku]; }
    Object.keys(state.recipes).forEach((fg) => state.recipes[fg].forEach((c) => { if (c.sku === sku) c.sku = ns; }));
    it.sku = ns;
    state.aliases[sku] = ns;
    state.log.push('Renamed ' + sku + ' to ' + ns + ' (old SKU kept as an alias)');
    return { ok: true };
  }
  function setUom(state, sku, uom) {
    const it = findItem(state, sku);
    if (!it) return { ok: false, problems: ['No item ' + sku + '.'] };
    if (!state.rules.uoms.includes(uom)) return { ok: false, problems: ['Unit must be one of ' + state.rules.uoms.join(', ') + '.'] };
    it.uom = uom;
    state.log.push('Set the unit of ' + sku + ' to ' + uom);
    return { ok: true };
  }
  function mapAlias(state, rawSku, targetSku) {
    const raw = String(rawSku || '').trim();
    const t = activeItems(state).find((x) => x.sku === targetSku);
    if (!raw) return { ok: false, problems: ['No channel SKU given.'] };
    if (!t) return { ok: false, problems: ['Pick an item to map ' + raw + ' to.'] };
    state.aliases[raw] = t.sku;
    state.log.push('Mapped ' + raw + ' to ' + t.sku);
    return { ok: true };
  }
  function addRecipeFromSheet(state, sku) {
    const rec = state.recipeSheet[sku];
    if (!rec) return { ok: false, problems: ['The recipe sheet has nothing for ' + sku + '.'] };
    const known = new Set(activeItems(state).map((x) => x.sku));
    const missing = rec.filter((c) => !known.has(c.sku)).map((c) => c.sku);
    if (missing.length) return { ok: false, problems: ['The sheet recipe uses ' + missing.join(', ') + ', which is not on the item list.'] };
    state.recipes[sku] = clone(rec);
    state.log.push('Added the recipe for ' + sku + ' from the recipe sheet');
    return { ok: true };
  }
  function removeComponent(state, fg, compSku) {
    const rec = state.recipes[fg];
    if (!rec || !rec.some((c) => c.sku === compSku)) return { ok: false, problems: [fg + ' has no ingredient ' + compSku + '.'] };
    state.recipes[fg] = rec.filter((c) => c.sku !== compSku);
    state.log.push('Removed ' + compSku + ' from the ' + fg + ' recipe');
    return { ok: true };
  }
  function addItem(state, item) {
    const problems = [];
    const sku = (item && item.sku || '').trim();
    if (!sku) problems.push('SKU is required.');
    else if (sku !== cleanSku(sku)) problems.push('Use the clean form: ' + cleanSku(sku) + ' (capitals, hyphens, no spaces).');
    else {
      const clash = activeItems(state).find((x) => cleanSku(x.sku) === cleanSku(sku));
      if (clash) problems.push(sku + ' would look identical to ' + clash.sku + '.');
    }
    if (!item || !item.name || !String(item.name).trim()) problems.push('Name is required.');
    if (!item || !TYPES.includes(item.type)) problems.push('Type must be finished or raw.');
    if (!item || !state.rules.uoms.includes(item.uom)) problems.push('Unit must be one of ' + state.rules.uoms.join(', ') + '.');
    if (problems.length) return { ok: false, problems };
    state.items.push({ sku, name: String(item.name).trim(), type: item.type, uom: item.uom, onHand: 0, reorderPoint: 0, cost: typeof item.cost === 'number' ? item.cost : null, active: true });
    state.log.push('Added item ' + sku);
    return { ok: true };
  }
  function addOrder(state, o) {
    const problems = [];
    if (!o || !String(o.retailer || '').trim()) problems.push('Retailer is required.');
    if (!o || !state.company.channels.includes(o.channel)) problems.push('Channel must be ' + state.company.channels.join(' or ') + '.');
    if (!o || !String(o.sku || '').trim()) problems.push('SKU is required (type it exactly as the channel sends it).');
    const q = Number(o && o.qty);
    if (!Number.isInteger(q) || q < 1 || q > 10000) problems.push('Quantity must be a whole number from 1 to 10000.');
    if (o && o.date != null && !isDate(o.date)) problems.push('Order date is not valid.');
    if (problems.length) return { ok: false, problems };
    const prefix = o.channel === 'Faire' ? 'F-' : 'M-';
    const n = 1 + state.orders.reduce((mx, x) => Math.max(mx, parseInt(String(x.id).replace(/\D/g, ''), 10) || 0), 0);
    const order = { id: prefix + n, channel: o.channel, retailer: String(o.retailer).trim(), date: o.date || state.company.today, status: 'open',
      qboInvoice: o.invoiced ? 'INV-' + (3000 + state.orders.length) : null, lines: [{ sku: String(o.sku).trim(), qty: q, price: Number(o.price) || 0 }] };
    state.orders.push(order);
    state.log.push('Added order ' + order.id + ' from ' + order.retailer);
    return { ok: true, order };
  }
  function setRules(state, patch) {
    const problems = [];
    const R = Object.assign({}, state.rules, patch || {});
    [['prepDays', 3, 10], ['freezeDays', 1, 5], ['parallelDays', 3, 10]].forEach(([k, lo, hi]) => {
      if (!Number.isInteger(R[k]) || R[k] < lo || R[k] > hi) problems.push(k + ' must be a whole number from ' + lo + ' to ' + hi + '.');
    });
    if (R.freezeDays >= R.prepDays) problems.push('The freeze must start inside the preparation window (fewer freeze days than preparation days).');
    if (problems.length) return { ok: false, problems };
    state.rules = R;
    return { ok: true };
  }
  function setCutover(state, dateStr) {
    const problems = checkCutover(state, dateStr);
    if (problems.length) return { ok: false, problems };
    state.cutover = dateStr;
    return { ok: true };
  }

  // ---------- exports ----------
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function planCsv(p) {
    return ['Date,Phase,Task,Owner'].concat(p.tasks.map((t) => [t.date, t.phase, t.title, t.owner].map(q).join(','))).join('\n');
  }
  function issuesCsv(a) {
    const rows = ['SKU,Item,Level,Issue'];
    a.rows.filter((r) => !r.skipped).forEach((r) => r.issues.forEach((x) => rows.push([r.item.sku, r.item.name, x.level, x.text].map(q).join(','))));
    return rows.join('\n');
  }

  return {
    ISSUE, prepare, newState, cleanSku, levenshtein, audit, matchLine, route, plan, earliestCutover, checkCutover,
    renameItem, setUom, mapAlias, addRecipeFromSheet, removeComponent, addItem, addOrder, setRules, setCutover,
    planCsv, issuesCsv, addBusinessDays, businessDaysBetween, isBusinessDay, nice
  };
});
