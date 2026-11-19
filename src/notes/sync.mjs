// 논문 하나의 로컬 메모 <-> Zotero 양방향 동기화. GET /notes 폴링마다 한 번 호출된다.
// 규칙: authorize()는 절대 부르지 않는다(인가 창은 사용자가 직접 연다). 실패해도 로컬 기록과
// pending op는 그대로 남는다. 내 태그(isMine)가 있고 key가 notes.json에 있는 항목만 고치거나 지운다.
// 304 캐시는 notes.libraryVersion.{annotations, note} 목록별로 따로 두며, 이번 동기화에서
// 우리가 쓴 것이 있으면 캐시를 믿지 않고 전체를 다시 받는다(우리 쓰기가 버전을 올렸으므로).
import crypto from 'node:crypto';
import { readNotes, writeNotes, readPending, writePending, withPaper, enqueue } from './store.mjs';
import { toZoteroAnnotation, matchSentences, isMine, TAG } from '../zotero/annotations.mjs';

const now = () => new Date().toISOString();
const SKIP = Symbol('skip'); // handler result: keep the op queued, continue with the next one
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

// note.sentHash: hash of the note HTML Zotero last had from us (detects edits made elsewhere).
// Zotero's note editor may wrap the HTML in <div data-schema-version="N">…</div>.
const unwrapNote = (html) => String(html ?? '').replace(/^<div data-schema-version="[^"]*">([\s\S]*)<\/div>$/, '$1');
const hashNote = (html) => crypto.createHash('sha256').update(unwrapNote(html)).digest('hex');

const dataOf = (item) => item?.data ?? item ?? {};
const keyOf = (item) => item?.key ?? item?.data?.key;
const versionOf = (item) => {
  const v = item?.version ?? item?.data?.version;
  return Number.isFinite(v) ? v : null;
};
const is412 = (err) => err?.code === 'http' && err.status === 412;
// Zotero will never accept this op as it is: createItems failed[] entries and 4xx other than
// 408/429. 412 is a version conflict, re-read on the next attempt, so it is not permanent.
const isPermanent = (err) => err?.permanent === true
  || (err?.code === 'http' && err.status >= 400 && err.status < 500 && ![408, 412, 429].includes(err.status));

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

function makeSync(ctx) {
  const { notes, pending, writer, source, cards, itemKey, attachmentKey } = ctx;

  const dropOp = (hid) => {
    pending.ops = pending.ops.filter((o) => !(o.op === 'upsert-highlight' && o.id === hid));
  };
  const dropHighlight = (hid) => {
    notes.highlights = notes.highlights.filter((h) => h.id !== hid);
    dropOp(hid);
  };
  // h.sent = the comment/color Zotero last had for this highlight (sent or adopted).
  const markSent = (h) => { h.sent = { comment: h.comment, color: h.color }; };
  const unsent = (h) => !h.sent || h.sent.comment !== h.comment || h.sent.color !== h.color;
  // Deleted (or untagged) in Zotero. With a pending local edit the memo must not vanish:
  // keep the record unlinked with a zoteroDeleted conflict (the user re-sends or deletes it).
  const goneInZotero = (h, pendingEdit) => {
    if (!pendingEdit && !unsent(h)) return dropHighlight(h.id);
    h.zoteroKey = null;
    h.zoteroVersion = null;
    delete h.sent;
    h.conflict = { mine: { comment: h.comment, color: h.color }, zoteroDeleted: true, at: now() };
    dropOp(h.id);
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
    markSent(h);
  };

  async function create(data) {
    const res = await writer.createItems([data]);
    const ok = res.successful?.[0] ?? res.successful?.['0'];
    const key = keyOf(ok) ?? res.success?.[0] ?? res.success?.['0'];
    if (!key) {
      const f = res.failed?.[0] ?? res.failed?.['0'];
      throw Object.assign(new Error(`Zotero 항목 생성 실패${f?.message ? `: ${f.message}` : ''}`), { permanent: true });
    }
    ctx.wrote = true;
    // The key must be saved even if the version lookup fails, or the next sync duplicates it.
    const version = versionOf(ok) ?? versionOf(await writer.getItem(key).catch(() => null));
    return { key, version };
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
      markSent(h);
      return;
    }
    const item = await writer.getItem(h.zoteroKey);
    // Deleted or untagged in Zotero: never recreated or touched; this op is a pending edit.
    if (!item || !isMine(item)) return goneInZotero(h, true);
    if (versionOf(item) !== h.zoteroVersion) return takeZotero(h, item);
    try {
      const sent = { comment: h.comment, color: h.color };
      h.zoteroVersion = await patch(h.zoteroKey, h.zoteroVersion, {
        annotationComment: sent.comment, annotationColor: sent.color,
      });
      h.sent = sent;
    } catch (err) {
      if (!is412(err)) throw err;
      const fresh = await writer.getItem(h.zoteroKey);
      if (fresh) takeZotero(h, fresh);
      else goneInZotero(h, true);
    }
  }

  async function deleteHighlight(op) {
    const t = notes.tombstones.find((x) => x.id === op.id);
    if (t) {
      const item = await writer.getItem(t.zoteroKey);
      if (item && isMine(item) && versionOf(item) !== t.zoteroVersion) {
        // Changed in Zotero since we last saw it: do not delete, bring it back with Zotero's values.
        const d = dataOf(item);
        notes.highlights.push({
          id: t.id,
          sentenceIds: Array.isArray(t.sentenceIds) ? t.sentenceIds : matchSentences(d, source).sentenceIds,
          color: d.annotationColor || t.color || '#ffd400',
          comment: d.annotationComment ?? '',
          zoteroKey: t.zoteroKey,
          zoteroVersion: versionOf(item),
          sent: { comment: d.annotationComment ?? '', color: d.annotationColor || t.color || '#ffd400' },
          conflict: { mine: { deleted: true }, at: now() },
          createdAt: t.createdAt ?? now(),
        });
      } else if (item && isMine(item)) {
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

  // Zotero-side note edit: flag it and adopt Zotero's version, so an explicit overwrite won't 412.
  const markNoteConflict = (item) => {
    notes.note.conflict ??= { at: now() };
    notes.note.zoteroVersion = versionOf(item);
  };

  async function upsertNote() {
    const n = notes.note;
    const html = noteHtml(cards, notes.cardMemos);
    if (n.zoteroKey) {
      if (n.conflict) return SKIP; // waits for resolveNoteConflict
      if (n.zoteroEdited) {
        // User chose to keep Zotero's note: never write over it; ask again (banner).
        n.conflict = { at: now() };
        return SKIP;
      }
      const item = await writer.getItem(n.zoteroKey);
      if (item) {
        if (!isMine(item)) return;
        if (versionOf(item) !== n.zoteroVersion) {
          markNoteConflict(item);
          return SKIP;
        }
        try {
          n.zoteroVersion = await patch(n.zoteroKey, n.zoteroVersion, { note: html });
          n.sentHash = hashNote(html);
        } catch (err) {
          if (!is412(err)) throw err;
          const fresh = await writer.getItem(n.zoteroKey);
          if (fresh) markNoteConflict(fresh);
          return SKIP;
        }
        return;
      }
      notes.note = { zoteroKey: null, zoteroVersion: null }; // deleted in Zotero: start a new note
    }
    if (!Object.values(notes.cardMemos).some((t) => typeof t === 'string' && t.trim())) return;
    const { key, version } = await create({
      itemType: 'note', parentItem: itemKey, note: html, tags: [{ tag: TAG }],
    });
    notes.note = { zoteroKey: key, zoteroVersion: version, sentHash: hashNote(html) };
  }

  // Server id changed. Two computers syncing one library share item keys, so look each stored
  // key up on the new server: there and mine → keep the key, adopt its version (and values, as
  // a pull would); missing → clear the key and queue a create. All lookups run before anything
  // changes, so a failed lookup leaves notes untouched (retried next sync). Never patches or
  // deletes with the old server's versions.
  async function adoptServer(serverId) {
    const lookup = async (key) => (key ? writer.getItem(key) : null);
    const hs = [];
    for (const h of notes.highlights) if (h.zoteroKey) hs.push([h, await lookup(h.zoteroKey)]);
    const ts = [];
    for (const t of notes.tombstones) ts.push([t, await lookup(t.zoteroKey)]);
    const noteItem = await lookup(notes.note.zoteroKey);

    const queued = new Set(pending.ops.filter((o) => o.op === 'upsert-highlight').map((o) => o.id));
    for (const [h, item] of hs) {
      if (!item) {
        h.zoteroKey = null;
        h.zoteroVersion = null;
        delete h.sent;
        enqueue(pending, 'upsert-highlight', h.id);
        continue;
      }
      if (!isMine(item)) { h.zoteroVersion = versionOf(item); continue; } // untagged: flush/pull rules apply
      const d = dataOf(item);
      const z = { comment: d.annotationComment ?? '', color: d.annotationColor || h.color };
      const sameAsSent = h.sent && z.comment === h.sent.comment && z.color === h.sent.color;
      if (sameAsSent || (z.comment === h.comment && z.color === h.color)) {
        h.zoteroVersion = versionOf(item); // unchanged in Zotero: a queued edit patches normally
        h.sent = z;
      } else if (queued.has(h.id) || unsent(h)) {
        takeZotero(h, item); // both sides changed: Zotero wins, mine shown
        dropOp(h.id);
      } else {
        h.comment = z.comment;
        h.color = z.color;
        h.zoteroVersion = versionOf(item);
        markSent(h);
      }
    }
    for (const [t, item] of ts) {
      if (!item || !isMine(item)) {
        notes.tombstones = notes.tombstones.filter((x) => x !== t);
        pending.ops = pending.ops.filter((o) => !(o.op === 'delete-highlight' && o.id === t.id));
        continue;
      }
      const d = dataOf(item);
      const z = { comment: d.annotationComment ?? '', color: d.annotationColor || t.color };
      const ref = t.sent ?? { comment: t.comment, color: t.color };
      // Unchanged → delete with the new version; changed elsewhere → null forces the restore path.
      t.zoteroVersion = z.comment === ref.comment && z.color === ref.color ? versionOf(item) : null;
    }
    const n = notes.note;
    if (n.zoteroKey && !noteItem) {
      notes.note = { zoteroKey: null, zoteroVersion: null };
      if (Object.values(notes.cardMemos).some((t) => typeof t === 'string' && t.trim())) enqueue(pending, 'upsert-note');
    } else if (noteItem) {
      n.zoteroVersion = versionOf(noteItem);
      if (isMine(noteItem)) {
        const zh = hashNote(dataOf(noteItem).note);
        if (zh === hashNote(noteHtml(cards, notes.cardMemos))) n.sentHash = zh;
        else if (zh !== n.sentHash) n.conflict ??= { at: now() }; // edited elsewhere: like a pull
      }
    }
    for (const o of pending.ops) { delete o.error; delete o.failedAt; }
    notes.serverId = serverId;
    notes.libraryVersion = { annotations: null, note: null };
    notes.zoteroAnnotations = [];
  }

  const handlers = { 'upsert-highlight': upsertHighlight, 'delete-highlight': deleteHighlight, 'upsert-note': upsertNote };

  // Front to back; the first transient failure stops the flush and stays queued. Skipped ops
  // (held conflicts, permanently failed ops marked { error, failedAt }) stay in place.
  // A failed op is retried only after enqueue() clears its mark (user edit) or a server change.
  async function flush() {
    let i = 0;
    while (i < pending.ops.length) {
      const op = pending.ops[i];
      if (op.error) { i++; continue; }
      const handler = handlers[op.op];
      let result;
      try {
        if (handler) result = await handler(op);
      } catch (err) {
        if (err?.message === 'NEEDS_REEXTRACT') {
          return { status: 'connected', message: `원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- ${ctx.id}` };
        }
        const status = STATUS_BY_CODE[err?.code];
        if (status) return { status, message: err.message ?? null };
        if (isPermanent(err)) {
          op.error = `Zotero가 받지 않았습니다: ${err?.message ?? err}`;
          op.failedAt = now();
          await ctx.save();
          i++;
          continue;
        }
        return { status: 'connected', message: `Zotero 동기화 실패: ${err?.message ?? err}` };
      }
      if (result === SKIP) i++;
      else pending.ops = pending.ops.filter((o) => o !== op);
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
          markSent(h);
        }
        continue;
      }
      if (gone.has(key) || isMine(item)) continue; // ours (pending delete / unknown copy): not user-made
      others.push(zoteroEntry(item, source));
    }
    // Missing from the list: confirm before dropping (the list could be truncated).
    for (const [key, h] of mine) {
      if (!seen.has(key) && !(await writer.getItem(key))) goneInZotero(h, queued.has(h.id));
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
      markNoteConflict(item); // upsert-note ops are held until the user resolves it
    }
    if (Number.isFinite(res.libraryVersion)) notes.libraryVersion.note = res.libraryVersion;
  }

  return { flush, pullAnnotations, pullNote, adoptServer };
}

async function runSync(outputDir, id, { source, cards, writer, serverInfo }) {
  const notes = await readNotes(outputDir, id);
  const pending = await readPending(outputDir, id);
  const done = (status, message = null) => {
    const failed = pending.ops.filter((o) => o.error);
    return { status, pending: pending.ops.length, message, failed: failed.length, failedMessage: failed[0]?.error ?? null };
  };

  if (!serverInfo?.running) return done('offline', serverInfo?.message ?? null);
  const { itemKey, attachmentKey } = source?.zotero ?? {};
  if (!itemKey || !attachmentKey) return done('offline', '이 논문은 Zotero 항목과 연결되어 있지 않습니다.');

  const ctx = {
    id, notes, pending, writer, source, cards, itemKey, attachmentKey, wrote: false,
    save: async () => {
      await writeNotes(outputDir, id, notes);
      await writePending(outputDir, id, pending);
    },
  };
  const sync = makeSync(ctx);
  if (serverInfo.serverId && notes.serverId !== serverInfo.serverId) {
    if (notes.serverId) {
      try {
        await sync.adoptServer(serverInfo.serverId);
      } catch (err) {
        return done(STATUS_BY_CODE[err?.code] ?? 'connected', `Zotero 서버 변경 확인 실패: ${err?.message ?? err}`);
      }
    } else notes.serverId = serverInfo.serverId;
    await ctx.save();
  }

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
