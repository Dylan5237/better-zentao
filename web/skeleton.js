// A host owns one pending read. A late response must never remove its successor.
const pending = new WeakMap();
export function beginSkeleton(host, scene, { signal, current } = {}) {
  if (signal?.aborted || (current && !current())) return () => {};
  const previous = pending.get(host);
  const visible = Boolean(previous?.node);
  previous?.finish();
  const request = { finish, node: undefined };
  let timer;
  host.setAttribute("aria-busy", "true");
  function show() {
    if (current && !current()) {
      finish();
      return;
    }
    const node = scene(host.ownerDocument);
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("inert", "");
    request.node = node;
    host.replaceChildren(node);
  }
  function finish() {
    if (pending.get(host) !== request) return;
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    request.node?.remove?.();
    if (host.removeAttribute) host.removeAttribute("aria-busy");
    else host.setAttribute("aria-busy", "false");
    pending.delete(host);
  }
  pending.set(host, request);
  signal?.addEventListener("abort", finish, { once: true });
  if (visible) show();
  else timer = setTimeout(show, 120);
  return finish;
}

function element(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function skeletonBlock(doc, kind = "text") {
  return element(doc, "span", "sk-block sk-" + kind);
}
export function skeletonText(doc, lines = 2) {
  const group = element(doc, "div", "sk-lines");
  for (let i = 0; i < lines; i++)
    group.append(
      skeletonBlock(doc, i === lines - 1 && lines > 1 ? "short" : "text"),
    );
  return group;
}
export function skeletonRows(doc, count = 4, draw) {
  const list = element(doc, "div", "sk-rows");
  for (let i = 0; i < count; i++) {
    const row = element(doc, "div", "item-row sk-row");
    if (draw) draw(row);
    else row.append(skeletonText(doc), skeletonBlock(doc, "chip"));
    list.append(row);
  }
  return list;
}
export function skeletonCard(doc, content, className = "vp-card") {
  const card = element(doc, "div", className + " sk-card");
  card.append(skeletonBlock(doc, "title"), content ?? skeletonRows(doc));
  return card;
}
export function skeletonTable(doc, columns = 4, rows = 4) {
  const wrap = element(doc, "div", "table-wrap sk-table");
  const table = element(doc, "table", "data-table");
  const head = element(doc, "thead"),
    body = element(doc, "tbody");
  function row(section, tag) {
    const tr = element(doc, "tr");
    for (let i = 0; i < columns; i++) {
      const cell = element(doc, tag);
      cell.append(skeletonBlock(doc, i === 0 ? "short" : "text"));
      tr.append(cell);
    }
    section.append(tr);
  }
  row(head, "th");
  for (let i = 0; i < rows; i++) row(body, "td");
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
