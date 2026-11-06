import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4173"
KEY = "preview-key-0123456789"
results = []

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

def unlock(pg):
    pg.goto(BASE, wait_until="networkidle")
    if pg.is_visible("#app"):
        return
    pg.fill("#lock-key", KEY)
    pg.click("#lock-submit")
    pg.wait_for_selector("#app:not([hidden])", timeout=6000)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 820})
    pg = ctx.new_page()
    pg.on("dialog", lambda d: d.accept())
    errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.goto(BASE, wait_until="networkidle")

    check("lock screen shown", pg.is_visible("#lock-screen"))
    pg.fill("#lock-key", "wrong-key-entirely")
    pg.click("#lock-submit")
    pg.wait_for_timeout(900)
    check("wrong key rejected", pg.is_visible("#lock-error") and not pg.is_visible("#app"))

    unlock(pg)
    check("board visible after key", pg.is_visible("#app"))
    rows = pg.query_selector_all("#note-list [role=option]")
    check("notes listed", len(rows) > 0, f"{len(rows)} rows")
    titles = [r.inner_text().split("\n")[0].strip() for r in rows]
    untitled = sum(1 for t in titles if t.lower() in ("untitled", ""))
    check("no Untitled rows", untitled == 0, f"{untitled}")

    # search
    pg.fill("#search", "ssh")
    pg.wait_for_timeout(300)
    filtered = len(pg.query_selector_all("#note-list [role=option]"))
    check("search filters", filtered < len(rows), f"{filtered}/{len(rows)}")
    pg.fill("#search", "")
    pg.wait_for_timeout(250)

    # keyboard: arrow + enter opens note
    pg.focus("#note-list")
    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(150)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(500)
    check("keyboard opens note", pg.input_value("#note-title") != "" or pg.is_visible("#note-editor"))

    # dirty guard
    pg.fill("#note-editor", "draft-in-progress-xyz")
    rows = pg.query_selector_all("#note-list [role=option]")
    rows[2].click()
    pg.wait_for_timeout(400)
    check("dirty guard prompts", pg.is_visible("#confirm"))
    pg.click("#confirm-cancel")
    pg.wait_for_timeout(200)

    # save flow
    unlock(pg)
    pg.click("#new-btn")
    pg.wait_for_timeout(250)
    pg.fill("#note-title", "preview check note")
    pg.fill("#note-editor", "body from the preview check")
    pg.click("#save-btn")
    pg.wait_for_timeout(1500)
    toast_cls = pg.get_attribute("#toast", "class") or ""
    toast_vis = pg.is_visible("#toast")
    tone = pg.get_attribute("#toast", "data-tone") or ""
    check("save shows success toast", toast_vis and tone == "ok", f"{toast_cls} tone={tone}")

    # xss
    unlock(pg)
    pg.click("#new-btn")
    pg.fill("#note-title", "<img src=x onerror=window.__xss=1>")
    pg.fill("#note-editor", "<script>window.__xss=2</script>")
    pg.click("#save-btn")
    pg.wait_for_timeout(1500)
    check("xss payload inert", pg.evaluate("window.__xss || 0") == 0)

    # headers
    resp = pg.request.get(BASE + "/")
    h = resp.headers
    check("CSP present", "content-security-policy" in h)
    check("nosniff present", h.get("x-content-type-options") == "nosniff")
    check("frame denied", h.get("x-frame-options") == "DENY")

    # auth on api
    r = pg.request.post(BASE + "/api/notes", data={"title": "x", "content": "y"})
    check("anon POST rejected", r.status == 401, str(r.status))
    r2 = pg.request.get(BASE + "/api/notes")
    check("anon GET rejected", r2.status == 401, str(r2.status))

    # mobile
    m = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.on("dialog", lambda d: d.accept())
    unlock(mp)
    if mp.is_visible("#back-btn"):
        mp.click("#back-btn")
    mp.click("#new-btn")
    mp.wait_for_timeout(300)
    box = mp.query_selector("#save-btn").bounding_box()
    check("save on screen at 390", box and box["x"] >= 0 and box["x"] + box["width"] <= 390, str(box))
    check("no horizontal overflow", not mp.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"))
    small = mp.evaluate("""() => [...document.querySelectorAll('button,a,input,textarea')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.height<32; }).length""")
    check("no tiny tap targets", small == 0, f"{small}")

    # persistence after reload
    unlock(mp)
    body = mp.inner_text("#note-list")
    check("new note persisted", "preview check note" in body)

    real = [e for e in errors if "401" not in e]
    check("no unexpected console errors", len(real) == 0, "; ".join(real[:3]))
    b.close()

fails = [r for r in results if not r[1]]
for n, ok, d in results:
    print(("PASS " if ok else "FAIL ") + n + (f"  [{d}]" if d else ""))
print(f"\n{len(results)-len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
