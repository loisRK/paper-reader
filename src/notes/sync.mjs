// 논문 하나의 로컬 메모 <-> Zotero 양방향 동기화. GET /notes 폴링마다 한 번 호출된다.
// 규칙: authorize()는 절대 부르지 않는다(인가 창은 사용자가 직접 연다). 실패해도 로컬 기록과
// pending op는 그대로 남는다. 내 태그(isMine)가 있고 key가 notes.json에 있는 항목만 고치거나 지운다.
// 304 캐시는 notes.libraryVersion.{annotations, note} 목록별로 따로 두며, 이번 동기화에서
// 우리가 쓴 것이 있으면 캐시를 믿지 않고 전체를 다시 받는다(우리 쓰기가 버전을 올렸으므로).
import { readNotes, writeNotes, readPending, writePending, withPaper, enqueue } from './store.mjs';
import { toZoteroAnnotation, matchSentences, isMine, TAG } from '../zotero/annotations.mjs';

const now = () => new Date().toISOString();
const TEXT_TYPES = new Set(['highlight', 'underline']);
const STATUS_BY_CODE = {
  offline: 'offline',
  'needs-auth': 'needs-auth',
  'server-changed': 'needs-auth', // writer dropped its keys; next sync sees the new server id
  denied: 'denied',
  'rate-limited': 'rate-limited',
  readonly: 'readonly',
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function noteHtml(cards, cardMemos) {
  let html = '<h1>Paper Reader 메모</h1>';
  (Array.isArray(cards) ? cards : []).forEach((card, i) => {
    const text = cardMemos?.[card.id];
    if (typeof text !== 'string' || !text.trim()) return;
    html += `<h2>${i + 1}. ${escapeHtml(card.question ?? '')}</h2>`
      + `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`;
  });
  return html;
}

const dataOf = (item) => item?.data ?? item ?? {};
const keyOf = (item) => item?.key ?? item?.data?.key;
const versionOf = (item) => {
  const v = item?.version ?? item?.data?.version;
  return Number.isFinite(v) ? v : null;
};
const is412 = (err) => err?.code === 'http' && err.status === 412;

function pageOf(annotationPosition) {
  try {
    const pos = typeof annotationPosition === 'string' ? JSON.parse(annotationPosition) : annotationPosition;
    return Number.isInteger(pos?.pageIndex) ? pos.pageIndex + 1 : 0;
  } catch {
    return 0;
  }
}

function zoteroEntry(item, source) {
  const d = dataOf(item);
  const { page, sentenceIds } = TEXT_TYPES.has(d.annotationType)
    ? matchSentences(d, source)
    : { page: pageOf(d.annotationPosition), sentenceIds: [] };
  return {
    key: keyOf(item), page, sentenceIds,
    text: d.annotationText ?? '', comment: d.annotationComment ?? '', color: d.annotationColor ?? '',
  };
}

function resetForNewServer(notes, pending, serverId) {
  for (const h of notes.highlights) {
    h.zoteroKey = null;
    h.zoteroVersion = null;
  }
  notes.serverId = serverId;
  notes.note = { zoteroKey: null, zoteroVersion: null };
  notes.libraryVersion = { annotations: null, note: null };
  notes.zoteroAnnotations = [];
  notes.tombstones = []; // old library's items: never deleted from the new one
  pending.ops = [];
  for (const h of notes.highlights) enqueue(pending, 'upsert-highlight', h.id);
  if (Object.values(notes.cardMemos).some((t) => typeof t === 'string' && t.trim())) enqueue(pending, 'upsert-note');
}

function makeSync(ctx) {
  const { notes, pending, writer, source, cards, itemKey, attachmentKey } = ctx;

  const dropHighlight = (hid) => {
    notes.highlights = notes.highlights.filter((h) => h.id !== hid);
    pending.ops = pending.ops.filter((o) => !(o.op === 'upsert-highlight' && o.id === hid));
  };

  // Zotero value wins; my differing value is kept in conflict.mine.
  const takeZotero = (h, item) => {
    const d = dataOf(item);
    const z = { comment: d.annotationComment ?? '', color: d.annotationColor || h.color };
    if (z.comment !== h.comment || z.color !== h.color) {
      h.conflict = { mine: { comment: h.comment, color: h.color }, at: now() };
    }
    h.comment = z.comment;
    h.color = z.color;
    h.zoteroVersion = versionOf(item);
  };

  async function create(data) {
    const res = await writer.createItems([data]);
    const ok = res.successful?.[0] ?? res.successful?.['0'];
    const key = keyOf(ok) ?? res.success?.[0] ?? res.success?.['0'];
    if (!key) {
      const f = res.failed?.[0] ?? res.failed?.['0'];
      throw new Error(`Zotero 항목 생성 실패${f?.message ? `: ${f.message}` : ''}`);
    }
    ctx.wrote = true;
    return { key, version: versionOf(ok) ?? versionOf(await writer.getItem(key)) };
  }

  async function patch(key, version, data) {
    const v = await writer.patchItem(key, version, data);
    ctx.wrote = true;
    return v ?? versionOf(await writer.getItem(key)) ?? version;
  }

  async function upsertHighlight(op) {
    const h = notes.highlights.find((x) => x.id === op.id);
    if (!h) return;
    if (!h.zoteroKey) {
      const { key, version } = await create(toZoteroAnnotation(h, source, attachmentKey));
      h.zoteroKey = key;
      h.zoteroVersion = version;
      return;
    }
    const item = await writer.getItem(h.zoteroKey);
    if (!item) return dropHighlight(h.id); // deleted in Zotero: never recreated
    if (!isMine(item)) return; // tag removed in Zotero: leave it alone
    if (versionOf(item) !== h.zoteroVersion) return takeZotero(h, item);
    try {
      h.zoteroVersion = await patch(h.zoteroKey, h.zoteroVersion, {
        annotationComment: h.comment, annotationColor: h.color,
      });
    } catch (err) {
      if (!is412(err)) throw err;
      const fresh = await writer.getItem(h.zoteroKey);
      if (fresh) takeZotero(h, fresh);
      else dropHighlight(h.id);
    }
  }

  async function deleteHighlight(op) {
    const t = notes.tombstones.find((x) => x.id === op.id);
    if (t) {
      const item = await writer.getItem(t.zoteroKey);
      if (item && isMine(item)) {
        try {
          await writer.deleteItem(t.zoteroKey, versionOf(item));
          ctx.wrote = true;
        } catch (err) {
          if (!(err?.code === 'http' && err.status === 404)) throw err;
        }
      }
    }
    notes.tombstones = notes.tombstones.filter((x) => x.id !== op.id);
  }

  async function upsertNote() {
    const n = notes.note;
    const html = noteHtml(cards, notes.cardMemos);
    if (n.zoteroKey) {
      const item = await writer.getItem(n.zoteroKey);
      if (item) {
        if (!isMine(item)) return;
        // Edited in Zotero (version moved): do not overwrite, just flag it.
        if (versionOf(item) !== n.zoteroVersion) {
          n.conflict ??= { at: now() };
          return;
        }
        try {
          n.zoteroVersion = await patch(n.zoteroKey, n.zoteroVersion, { note: html });
        } catch (err) {
          if (!is412(err)) throw err;
          n.conflict ??= { at: now() };
        }
        return;
      }
      notes.note = { zoteroKey: null, zoteroVersion: null }; // deleted in Zotero: start a new note
    }
    if (!Object.values(notes.cardMemos).some((t) => typeof t === 'string' && t.trim())) return;
    const { key, version } = await create({
      itemType: 'note', parentItem: itemKey, note: html, tags: [{ tag: TAG }],
    });
    notes.note = { zoteroKey: key, zoteroVersion: version };
  }

  const handlers = { 'upsert-highlight': upsertHighlight, 'delete-highlight': deleteHighlight, 'upsert-note': upsertNote };

  // Front to back; the first failure stops the flush and stays queued.
  async function flush() {
    while (pending.ops.length) {
      const op = pending.ops[0];
      const handler = handlers[op.op];
      try {
        if (handler) await handler(op);
      } catch (err) {
        if (err?.message === 'NEEDS_REEXTRACT') {
          return { status: 'connected', message: `원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- ${ctx.id}` };
        }
        const status = STATUS_BY_CODE[err?.code];
        if (status) return { status, message: err.message ?? null };
        return { status: 'connected', message: `Zotero 동기화 실패: ${err?.message ?? err}` };
      }
      pending.ops = pending.ops.filter((o) => o !== op);
      await ctx.save();
    }
    return { status: 'connected', message: null };
  }

  async function pullAnnotations() {
    const since = ctx.wrote ? undefined : (notes.libraryVersion.annotations ?? undefined);
    const res = await writer.listChildren(attachmentKey, since, { itemType: 'annotation' });
    if (res.notModified) return;
    const mine = new Map(notes.highlights.filter((h) => h.zoteroKey).map((h) => [h.zoteroKey, h]));
    const gone = new Set(notes.tombstones.map((t) => t.zoteroKey));
    const queued = new Set(pending.ops.filter((o) => o.op === 'upsert-highlight').map((o) => o.id));
    const seen = new Set();
    const others = [];
    for (const item of res.items ?? []) {
      const d = dataOf(item);
      const key = keyOf(item);
      if (d.itemType && d.itemType !== 'annotation') continue;
      const h = mine.get(key);
      if (h) {
        seen.add(key);
        // A queued local edit is newer; the flush handles conflicts for it.
        if (!queued.has(h.id) && isMine(item) && versionOf(item) !== h.zoteroVersion) {
          h.comment = d.annotationComment ?? '';
          h.color = d.annotationColor || h.color;
          h.zoteroVersion = versionOf(item);
        }
        continue;
      }
      if (gone.has(key) || isMine(item)) continue; // ours (pending delete / unknown copy): not user-made
      others.push(zoteroEntry(item, source));
    }
    // Missing from the list: confirm before dropping (the list could be truncated).
    for (const [key, h] of mine) {
      if (!seen.has(key) && !(await writer.getItem(key))) dropHighlight(h.id);
    }
    notes.zoteroAnnotations = others;
    if (Number.isFinite(res.libraryVersion)) notes.libraryVersion.annotations = res.libraryVersion;
  }

  async function pullNote() {
    const n = notes.note;
    if (!n.zoteroKey) return;
    const since = ctx.wrote ? undefined : (notes.libraryVersion.note ?? undefined);
    const res = await writer.listChildren(itemKey, since, { itemType: 'note' });
    if (res.notModified) return;
    const item = (res.items ?? []).find((it) => keyOf(it) === n.zoteroKey) ?? (await writer.getItem(n.zoteroKey));
    if (!item) {
      notes.note = { zoteroKey: null, zoteroVersion: null }; // deleted in Zotero; memos stay local
    } else if (versionOf(item) !== n.zoteroVersion) {
      n.conflict ??= { at: now() }; // keep the old version so we never overwrite the user's edit
    }
    if (Number.isFinite(res.libraryVersion)) notes.libraryVersion.note = res.libraryVersion;
  }

  return { flush, pullAnnotations, pullNote };
}

async function runSync(outputDir, id, { source, cards, writer, serverInfo }) {
  const notes = await readNotes(outputDir, id);
  const pending = await readPending(outputDir, id);
  const done = (status, message = null) => ({ status, pending: pending.ops.length, message });

  if (!serverInfo?.running) return done('offline');
  const { itemKey, attachmentKey } = source?.zotero ?? {};
  if (!itemKey || !attachmentKey) return done('offline', '이 논문은 Zotero 항목과 연결되어 있지 않습니다.');

  const ctx = {
    id, notes, pending, writer, source, cards, itemKey, attachmentKey, wrote: false,
    save: async () => {
      await writeNotes(outputDir, id, notes);
      await writePending(outputDir, id, pending);
    },
  };
  if (serverInfo.serverId && notes.serverId !== serverInfo.serverId) {
    if (notes.serverId) resetForNewServer(notes, pending, serverInfo.serverId);
    else notes.serverId = serverInfo.serverId;
    await ctx.save();
  }

  const sync = makeSync(ctx);
  let status = 'readonly';
  let message = null;
  if (serverInfo.writable) {
    ({ status, message } = await sync.flush());
    if (status === 'offline') return done(status, message);
  }
  try {
    await sync.pullAnnotations();
    await sync.pullNote();
  } catch (err) {
    if (err?.code === 'offline' || err?.code === 'readonly') status = err.code;
    else message ??= `Zotero에서 가져오기 실패: ${err?.message ?? err}`;
  }
  await ctx.save();
  return done(status, message);
}

export function syncPaper(outputDir, id, opts) {
  return withPaper(outputDir, id, () => runSync(outputDir, id, opts));
}
