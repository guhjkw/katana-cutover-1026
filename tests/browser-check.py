"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html, works through every fix, refuses bad input,
and fails on any console or page error. Screenshots go to tests/.
"""
import asyncio, functools, http.server, pathlib, socketserver, threading
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        k = lambda key: pg.locator(f'.kpi[data-k={key}] b').inner_text()
        route = lambda oid: pg.locator(f'#ordBody tr[data-order="{oid}"]').get_attribute('data-route')

        print('\n1. The page loads on the planner with the invented brand')
        await pg.goto(base)
        await pg.wait_for_selector('#ordBody tr')
        ok('21 of 27 items ready, 4 root problems', await k('ready') == '21/27' and await k('root') == '4')
        ok('0 of 8 open orders can move today', await k('moving') == '0 of 8')
        ok('5 lines fail an exact SKU match, 2 orders guarded from double billing', await k('exact') == '5' and await k('guard') == '2')
        ok('switch on Mon 9 Nov is 10 business days away', await k('days') == '10')
        ok('8 orders shown as blocked', await pg.locator('#ordBody tr[data-route=blocked]').count() == 8)
        ok('"BBQ SAUCE 12" is flagged as "which one?"', 'which one?' in await pg.locator('#ordBody tr[data-order="M-77105"]').inner_text())

        print('\n2. Item readiness tab')
        await pg.click('.side button[data-tab=items]')
        ok('6 blocked items listed', await pg.locator('#itemBody tr').count() == 6)
        await pg.click('.seg button[data-f=all]')
        ok('all 28 items listed, the inactive one marked as left out', await pg.locator('#itemBody tr').count() == 28 and 'left out' in await pg.locator('#itemBody tr[data-sku="Gift-Box-3"]').inner_text())
        await pg.click('.side button[data-tab=orders]')

        print('\n3. Fixes, one at a time')
        await pg.fill('#renameTo', 'bbq sauce 12')
        await pg.click('button[data-act=rename]')
        await pg.wait_for_function("document.getElementById('fixErr').textContent.length > 0", timeout=5000)
        ok('a messy new SKU is refused with the clean form', 'clean form' in await pg.inner_text('#fixErr'), await pg.inner_text('#fixErr'))
        await pg.fill('#renameTo', 'BBQ-SAUCE-12-CS')
        await pg.click('button[data-act=rename]')
        ok('renaming the case pack readies 3 items (24/27)', await k('ready') == '24/27', await k('ready'))
        ok('Bluegrass Gift Co. now moves as already invoiced', await route('M-77105') == 'katana_invoiced')
        ok('the change is logged', 'Renamed BBQ_SAUCE-12' in await pg.inner_text('#log'))
        await pg.select_option('#uomSel', 'ea')
        await pg.click('button[data-act=uom]')
        ok('setting the honey unit readies it (25/27)', await k('ready') == '25/27')
        await pg.click('button[data-act=recipe]')
        ok('the pepper jam recipe comes from the sheet (26/27)', await k('ready') == '26/27')
        await pg.click('button[data-act=addcomp]')
        ok('adding LABEL-GOLD as a raw material readies the Grand Gift Box (28/28)', await k('ready') == '28/28', await k('ready'))
        await pg.click('button[data-act=alias]')
        ok('accepting the suggestion moves Lexington Pantry', await route('M-77119') == 'katana')
        await pg.select_option('.mapSel', 'SB-1OIL')
        await pg.click('button[data-act=map]')
        ok('mapping CHILI-OIL-250 moves the last order: 8 of 8', await k('moving') == '8 of 8' and await k('root') == '0')
        ok('the fix list says nothing is left', 'Nothing left to fix' in await pg.inner_text('#fixes'))

        print('\n4. The switch date and rules')
        await pg.fill('#cutDate', '2026-11-07')
        await pg.dispatch_event('#cutDate', 'change')
        ok('a Saturday switch is refused with a reason', 'weekend or holiday' in await pg.inner_text('#planErr'))
        await pg.fill('#cutDate', '2026-10-29')
        await pg.dispatch_event('#cutDate', 'change')
        ok('a switch this week is refused as too soon', 'Too soon' in await pg.inner_text('#planErr'))
        await pg.fill('#cutDate', '2026-11-23')
        await pg.dispatch_event('#cutDate', 'change')
        await pg.click('.side button[data-tab=plan]')
        ok('switching on Mon 23 Nov moves the plan (20 business days, prep starts Mon 16 Nov)', await k('days') == '20' and 'Nov 16' in await pg.locator('#timeline .tl').first.inner_text())
        await pg.fill('#rFreeze', '6')
        await pg.dispatch_event('#rFreeze', 'change')
        ok('a 6-day freeze is refused', 'freezeDays must be' in await pg.inner_text('#planErr'))
        await pg.fill('#rFreeze', '2')
        await pg.dispatch_event('#rFreeze', 'change')

        print('\n5. Adding an order')
        await pg.click('.side button[data-tab=add]')
        await pg.fill('#oSku', 'Sm-Salt 4oz')
        ok('the SKU is read live as SM-SALT-4OZ before saving', 'SM-SALT-4OZ' in await pg.inner_text('#oHint'))
        await pg.click('#oAdd')
        ok('an order with no retailer is refused', 'Retailer is required' in await pg.inner_text('#oErr'))
        await pg.fill('#oRet', 'Paducah Provisions')
        await pg.fill('#oSku', 'Sm-Salt 4oz')
        await pg.fill('#oQty', '24')
        await pg.click('#oAdd')
        await pg.wait_for_selector('#ordBody tr[data-order="F-77127"]')
        ok('the new order moves to Katana', await route('F-77127') == 'katana')
        ok('open orders now 9 of 9', await k('moving') == '9 of 9')

        print('\n6. Export and reset')
        async with pg.expect_download() as dl:
            await pg.click('#csvBtn')
        d = await dl.value
        path = await d.path()
        text = pathlib.Path(path).read_text()
        ok('the CSV downloads with the plan and the issue list', text.startswith('Date,Phase,Task,Owner') and 'SKU,Item,Level,Issue' in text and d.suggested_filename == 'cutover-plan-2026-11-23.csv')
        await pg.click('#resetBtn')
        ok('reset brings back the starting data', await k('ready') == '21/27' and await k('moving') == '0 of 8')
        await pg.locator('#tool').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop.png'))
        await pg.locator('#pricing').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop-pricing.png'))

        print('\n7. Phone layout')
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base)
        await pm.wait_for_selector('#ordBody tr')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.locator('#tool').scroll_into_view_if_needed()
        await pm.screenshot(path=str(ROOT / 'tests' / 'shot-mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
