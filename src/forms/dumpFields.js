// Runs inside the page through Claude in Chrome's javascript tool.
// Serializes every visible form control to JSON so JEV can map it.
// Returns a string: JSON.stringify(FieldsDump). No side effects.
(() => {
  // Password inputs are never dumped: a page that asks for one is a login or account page, not an application form.
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "search", "password"]);
  const seenRadio = new Set();
  const fields = [];
  const out = { url: location.href, title: document.title, context: "", fields, submitSelectors: [] };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (el.type === "file") return true; // file inputs are routinely hidden behind a styled button
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // react-select and friends keep a transparent, focus-skipped input around for HTML5 validation.
    if (st.opacity === "0" && el.tabIndex === -1) return false;
    return true;
  };
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1"));
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  // Ids a UI library numbers on each render (FabricTextField-349, :r1:, radix-12) can change under us, so they are not used to find a field again.
  // An id that merely ends in digits (question_8595663005, school--0) is the form's own and stays put.
  const RENDER_ID = /^(:r|radix-|headlessui-|mui-|react-aria|downshift-|rc_select_|el-id-|Fabric[A-Za-z]*-?\d)/;
  const stableId = (id) => !!id && !RENDER_ID.test(id) && unique("#" + cssEscape(id));
  const selectorFor = (el) => {
    if (stableId(el.id)) return "#" + cssEscape(el.id);
    const tag = el.tagName.toLowerCase();
    if (el.name) {
      const s = `${tag}[name="${attr(el.name)}"]`;
      if (unique(s) || el.type === "radio") return s;
    }
    // Walk up until the path names exactly one element: two fields must never share a selector.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (stableId(cur.id)) { parts.unshift("#" + cssEscape(cur.id)); break; }
      const t = cur.tagName.toLowerCase();
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      if (parts.length >= 3 && unique(parts.join(" > "))) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  // Placeholder-style labels say nothing about the question. The real question is the text block just above the control.
  const GENERIC = /^(select|select\.\.\.|select an option|select one|please select|choose|choose one|search|search\.\.\.|type to search|start typing\.*|textbox)?$/i;
  const questionFor = (el) => {
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 7; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib) {
        // The page title is not a question, and anything above it belongs to another part of the page.
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const t = text(sib);
        if (t && t.length <= 300 && !GENERIC.test(t) && !sib.querySelector("input, select, textarea, [role=combobox]")) return t;
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  const cleanLabel = (el, label) => {
    const stripped = label.replace(/^(select\.\.\.|select an option|select|search|textbox)\s+/i, "").trim();
    if (stripped && !GENERIC.test(stripped)) return stripped;
    return questionFor(el).replace(/\s*[*✱]\s*$/, "").slice(0, 300) || label;
  };
  const labelFor = (el) => {
    const bits = [];
    if (el.id) document.querySelectorAll(`label[for="${cssEscape(el.id)}"]`).forEach((l) => bits.push(text(l)));
    const al = el.getAttribute("aria-label"); if (al) bits.push(al);
    const by = el.getAttribute("aria-labelledby");
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(text(n)); });
    const wrap = el.closest("label"); if (wrap) bits.push(text(wrap).replace(text(el), ""));
    if (!bits.join("").trim()) bits.push(questionFor(el));
    if (!bits.join("").trim()) {
      // Walk up to a field container and take its first heading or label-like text.
      let cur = el.parentElement, depth = 0;
      while (cur && depth < 4) {
        const l = cur.querySelector("label, legend, [class*=label i], [class*=question i], h3, h4, h5");
        if (l && text(l)) { bits.push(text(l)); break; }
        cur = cur.parentElement; depth++;
      }
    }
    return [...new Set(bits.map((b) => b.replace(/\s*[*✱]\s*$/, "").replace(/\s*[*✱]\s+/g, " ").trim()).filter(Boolean))].join(" ").slice(0, 300);
  };
  const hintFor = (el) => {
    const by = el.getAttribute("aria-describedby");
    const bits = [];
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(text(n)); });
    const c = el.closest("fieldset, [class*=field i], [class*=question i], [class*=form-group i], div");
    if (c) c.querySelectorAll("p, small, [class*=help i], [class*=hint i], [class*=description i]").forEach((n) => { const t = text(n); if (t && t.length < 400) bits.push(t); });
    return [...new Set(bits)].join(" ").slice(0, 400);
  };
  // The nearest heading or legend above the control, for context like "Education" or "Voluntary self-identification".
  const sectionFor = (el) => {
    const root = el.closest("form, [role=tabpanel], main") || document.body;
    let cur = el;
    while (cur && cur !== root && cur !== document.body) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$|^LEGEND$/.test(sib.tagName)) return text(sib).slice(0, 80);
        const h = sib.querySelector && sib.querySelector("h1, h2, h3, h4, legend");
        if (h && sib.querySelectorAll("input, select, textarea").length === 0) return text(h).slice(0, 80);
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  };
  const isRequired = (el, label) => el.required || el.getAttribute("aria-required") === "true" || /[*✱]\s*$|\(required\)/i.test(label) || /required/i.test(el.closest("[class*=required i]")?.className || "");

  // A plain text input with a suggestion list beside it (Lever's location box) only accepts a picked suggestion.
  const hasSuggestBox = (el) => el.tagName === "INPUT" && !!el.parentElement && !!el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i], [class*="typeahead" i], [class*="suggestions" i]');
  const controls = document.querySelectorAll("input, select, textarea, [role=combobox], [role=listbox]");
  const containerOf = (el) => el.closest("fieldset, [class*=field i], [class*=question i], [data-field-path], [id^=question], .form-group") || el.parentElement;
  const usedContainers = new Set();
  const dumped = new Set();
  let i = 0;
  controls.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
    if (SKIP_TYPES.has(type)) return;
    const isControl = ["input", "select", "textarea"].includes(tag);
    // Custom widgets (react-select wrappers, live regions) are reported once, through the real input in the same question.
    if (!isControl) {
      if (el.querySelector("input, select, textarea")) return;
      const c = containerOf(el);
      if (c && (usedContainers.has(c) || c.querySelector("input:not([type=hidden]), select, textarea"))) return;
    }
    if (isControl && type !== "radio") usedContainers.add(containerOf(el));
    if (!visible(el) && type !== "file") return;
    if (el.disabled || el.readOnly) return;
    const role = el.getAttribute("role");
    let kind;
    if (tag === "select") kind = "select";
    else if (tag === "textarea") kind = "textarea";
    else if (role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || role === "listbox" || hasSuggestBox(el)) kind = "combobox";
    else if (type === "radio") kind = "radio";
    else if (type === "checkbox") kind = "checkbox";
    else if (type === "file") kind = "file";
    else if (["email", "tel", "url", "number", "date"].includes(type)) kind = type;
    else kind = "text";

    const f = {
      id: "f" + i++,
      selector: selectorFor(el),
      kind,
      name: el.name || el.id || "",
      label: labelFor(el),
      hint: hintFor(el),
      placeholder: el.getAttribute("placeholder") || "",
      required: false,
      value: "",
      options: [],
      accept: el.getAttribute("accept") || "",
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      autocomplete: el.getAttribute("autocomplete") || "",
      section: sectionFor(el),
    };
    f.required = isRequired(el, f.label) || /[*✱]\s*$/.test(questionFor(el));
    if (kind !== "radio" && kind !== "checkbox") f.label = cleanLabel(el, f.label);

    if (kind === "radio") {
      const key = el.name || f.selector;
      if (seenRadio.has(key)) { i--; return; }
      seenRadio.add(key);
      const group = el.name ? document.querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`) : [el];
      group.forEach((r) => {
        const l = (r.id && document.querySelector(`label[for="${cssEscape(r.id)}"]`)) || r.closest("label");
        f.options.push({ value: r.value, label: text(l) || r.value });
        if (r.checked) f.value = r.value;
      });
      const fs = el.closest("fieldset");
      if (fs && fs.querySelector("legend")) f.label = text(fs.querySelector("legend")) || f.label;
      else if (!f.label || f.options.some((o) => o.label === f.label)) {
        let cur = el.parentElement, depth = 0;
        while (cur && depth < 5) { const l = cur.querySelector("legend, label, [class*=label i], h2, h3, h4"); if (l && text(l) && !f.options.some((o) => o.label === text(l))) { f.label = text(l); break; } cur = cur.parentElement; depth++; }
      }
    } else if (kind === "select") {
      [...el.options].forEach((o) => { if (o.value !== "" || o.text.trim()) f.options.push({ value: o.value, label: o.text.trim() }); });
      f.value = el.value;
    } else if (kind === "checkbox") {
      f.checked = el.checked;
      f.value = el.value;
    } else if (kind === "combobox") {
      f.value = el.value || "";
      const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      const list = listId ? document.getElementById(listId) : null;
      if (list) list.querySelectorAll("[role=option]").forEach((o) => f.options.push({ value: text(o), label: text(o) }));
    } else {
      f.value = el.value || "";
    }
    fields.push(f);
    dumped.add(el);
  });

  // Button groups: a labelled field whose choices are plain <button>s (Ashby's Yes/No, some custom forms).
  const groupContainers = document.querySelectorAll("[class*=field-entry i], [class*=fieldEntry], [class*=question i], fieldset, [role=radiogroup], [role=group]");
  const seenGroup = new Set();
  groupContainers.forEach((c) => {
    // A radiogroup drawn with role=radio rows keeps its real inputs invisible; it is read through the rows.
    const drawnRadios = c.getAttribute("role") === "radiogroup" && c.querySelector("[role=radio]") && ![...c.querySelectorAll("input[type=radio]")].some((r) => seenRadio.has(r.name || ""));
    // Skip a container whose control was already read. An input nobody can see (Ashby keeps a hidden checkbox
    // behind its Yes and No buttons) does not count: the buttons are the control.
    if (!drawnRadios && [...c.querySelectorAll("input, select, textarea")].some((x) => x.type !== "hidden" && (dumped.has(x) || visible(x)))) return;
    const buttons = [...c.querySelectorAll("button, [role=radio], [role=option]")].filter((b) => visible(b) && text(b).length > 0 && text(b).length <= 40 && !/upload|browse|remove|submit|apply|next|continue|back/i.test(text(b)));
    if (buttons.length < 2 || buttons.length > 12) return;
    if ([...seenGroup].some((prev) => prev.contains(c) || c.contains(prev))) return;
    seenGroup.add(c);
    const labelEl = drawnRadios ? null : c.querySelector("label, legend, [class*=question-title i], [class*=label i], h2, h3, h4");
    const label = labelEl ? text(labelEl) : questionFor(c) || text(c).split("\n")[0];
    const selected = buttons.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked" || b.dataset.selected === "true");
    fields.push({
      id: "f" + i++,
      selector: selectorFor(c),
      kind: "radio",
      name: c.getAttribute("data-field-path") || "",
      label: label.replace(/\s*[*✱]\s*$/, "").slice(0, 300),
      hint: hintFor(c),
      placeholder: "",
      required: /required/i.test(labelEl?.className || "") || /[*✱]\s*$/.test(labelEl ? text(labelEl) : label) || c.getAttribute("aria-required") === "true",
      value: selected ? text(selected) : "",
      options: buttons.map((b) => ({ value: text(b), label: text(b) })),
      accept: "",
      maxLength: null,
      autocomplete: "",
      section: sectionFor(c),
      buttonGroup: true,
    });
  });

  // Some careers sites embed the real form in an iframe (Greenhouse, Lever). Report those so the caller can navigate into one.
  out.hasPassword = [...document.querySelectorAll("input[type=password]")].some(visible);
  out.frames = [...document.querySelectorAll("iframe[src]")].map((f) => f.src).filter((src) => /greenhouse|lever\.co|ashbyhq|workday|smartrecruiters|jobvite|bamboohr|rippling|icims/i.test(src));
  const form = fields.length && document.querySelector(fields[0].selector)?.closest("form");
  const headings = [...(form || document).querySelectorAll("h1, h2, h3, p")].slice(0, 8).map(text).filter(Boolean);
  out.context = headings.join(" | ").slice(0, 800);
  (form || document).querySelectorAll("button, input[type=submit], [role=button]").forEach((b) => {
    const t = (text(b) || b.value || b.getAttribute("aria-label") || "").trim();
    if (/submit|apply|send|continue|next|review|finish/i.test(t) && visible(b)) out.submitSelectors.push(selectorFor(b) + "  /* " + t.slice(0, 40) + " */");
  });
  return JSON.stringify(out);
})();
