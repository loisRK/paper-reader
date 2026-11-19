// Tiny DOM helpers shared by the views. Touches `document` only when called.
// Data always goes in through textContent / attributes — never innerHTML.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  node.replaceChildren();
}

export function progressBar(value, max, label) {
  const bar = el('div', {
    class: 'progress',
    role: 'progressbar',
    'aria-valuemin': 0,
    'aria-valuemax': max,
    'aria-valuenow': value,
    'aria-label': label,
  });
  const fill = el('div', { class: 'progress-fill' });
  fill.style.width = `${max > 0 ? Math.round((value / max) * 100) : 0}%`;
  bar.append(fill);
  return bar;
}
