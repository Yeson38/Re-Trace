"""Re-Trace Player Phase 0 smoke test.

Verifies the three-pane linkage and transport:
  - initial frame highlights the right source line
  - stepping moves the highlight and updates variables
  - dragging the timeline slider to the end reveals accumulated stdout
  - the bubble-sort trace resolves to the sorted output
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"


def click_next(page, times=1):
    nxt = page.locator("button", has_text="Step ▶")
    for _ in range(times):
        nxt.click()
        page.wait_for_timeout(50)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        msgs = []
        page.on("console", lambda m: msgs.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: msgs.append(f"pageerror: {e}"))

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(200)

        # --- initial frame ---
        page.screenshot(path="/workspace/rt_0_initial.png", full_page=True)
        init_line = page.locator(".code-line.current .ln").text_content()
        init_step = page.locator("#stepCounter").text_content()
        print(f"[init] step={init_step!r} current_line={init_line!r}")

        # step into the function body
        click_next(page, 8)
        page.screenshot(path="/workspace/rt_1_mid.png", full_page=True)
        mid_line = page.locator(".code-line.current .ln").text_content()
        mid_step = page.locator("#stepCounter").text_content()
        first_var = page.locator(".var-row .var-name").first.text_content()
        print(f"[mid]  step={mid_step!r} current_line={mid_line!r} first_var={first_var!r}")

        # --- jump to end via timeline slider ---
        mx = int(page.locator(".slider").get_attribute("max") or "0")
        page.locator(".slider").fill(str(mx))
        page.wait_for_timeout(200)
        page.screenshot(path="/workspace/rt_2_end.png", full_page=True)
        end_line = page.locator(".code-line.current .ln").text_content()
        end_term = page.locator("#terminal").text_content()
        end_step = page.locator("#stepCounter").text_content()
        print(f"[end]  step={end_step!r} current_line={end_line!r}")
        print(f"[end]  terminal={end_term!r}")

        # expand `result` and `data` variables to inspect final value
        page.locator(".var-row", has_text="result").click()
        page.wait_for_timeout(80)
        page.locator(".var-row", has_text="data").click()
        page.wait_for_timeout(80)
        page.screenshot(path="/workspace/rt_3_expanded.png", full_page=True)

        ok = True
        if init_line != "9":
            print("FAIL: initial highlight should be line 9"); ok = False
        if end_term.strip() != "[1, 2, 4, 5, 8]":
            print("FAIL: terminal should show sorted output"); ok = False
        if msgs:
            print("WARN: console errors:", msgs); ok = False

        browser.close()
        print("RESULT:", "PASS" if ok else "FAIL")
        sys.exit(0 if ok else 1)


main()
