// /api/papers/:id/{notes,highlights,card-memos,note-conflict} 와 /api/zotero/authorize 라우트.
// 쓰기 라우트는 로컬 저장(notes.json/pending.json)만 하고 바로 응답한다.
// Zotero 전송은 GET /notes 폴링마다 실행되는 syncPaper가 맡는다.
import { readPaper } from './store.mjs';
import { readNotes, addHighlight, updateHighlight, removeHighlight, setCardMemo, resolveNoteConflict } from '../notes/store.mjs';
import { syncPaper } from '../notes/sync.mjs';
import { ZOTERO_COLORS, toZoteroAnnotation } from '../zotero/annotations.mjs';
import { getServerInfo as realGetServerInfo, createZoteroWriter } from '../zotero/write.mjs';

const MAX_SENTENCES = 20;
const MAX_COMMENT = 2000;
const MAX_MEMO = 5000;
const AUTH_STATUSES = new Set(['denied', 'rate-limited', 'readonly', 'offline']);
const COLORS = new Set(Object.values(ZOTERO_COLORS));
const EXAMPLE_MESSAGE = '예제 논문에는 메모를 저장하지 않습니다.';

const pageOf = (source, sid) => source.sentences?.[sid]?.page ?? 0;
const seqOf = (sid) => Number(/-s(\d+)$/.exec(sid)?.[1] ?? Infinity);

// helpers = { HttpError, checkName, readBody, sendJson, validated } from server.mjs
export function createNotesRoutes(cfg, { out, opts, fetchImpl, zotero }, helpers) {
  const { HttpError, checkName, readBody, sendJson, validated } = helpers;
  const getServerInfo = zotero?.getServerInfo ?? ((c) => realGetServerInfo(c, { fetchImpl }));
  // One writer per server: it holds the in-memory single-use key from "한 번만 허용".
  const writer = zotero?.writer ?? createZoteroWriter(cfg, { fetchImpl });

  async function loadPaper(id, { write = false } = {}) {
    const b = await readPaper(out, id, opts);
    if (!b) throw new HttpError(404, '논문을 찾을 수 없습니다.');
    if (write && b.example) throw new HttpError(403, EXAMPLE_MESSAGE);
    return b;
  }

  function checkStyle(body) {
    if (body.color !== undefined && !COLORS.has(body.color)) throw new HttpError(400, 'color는 Zotero 색상 값 중 하나여야 합니다.');
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > MAX_COMMENT)) {
      throw new HttpError(400, `comment는 ${MAX_COMMENT}자 이하의 문자열이어야 합니다.`);
    }
  }

  function parseHighlight(body, bundle) {
    const { source } = bundle;
    const ids = body?.sentenceIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SENTENCES || !ids.every((s) => typeof s === 'string')) {
      throw new HttpError(400, `sentenceIds는 문장 id ${MAX_SENTENCES}개 이하의 비어 있지 않은 배열이어야 합니다.`);
    }
    const unknown = ids.find((s) => !Object.hasOwn(source.sentences ?? {}, s));
    if (unknown) throw new HttpError(400, `이 논문에 없는 문장입니다: ${unknown}`);
    checkStyle(body);
    const sentenceIds = [...new Set(ids)].sort((a, b) => pageOf(source, a) - pageOf(source, b) || seqOf(a) - seqOf(b));
    // Reject what Zotero could never accept now, so a permanently failing op never blocks the queue.
    try {
      toZoteroAnnotation({ sentenceIds, color: body.color, comment: body.comment }, source, source.zotero?.attachmentKey ?? 'X');
    } catch (err) {
      if (err.message === 'NEEDS_REEXTRACT') {
        throw new HttpError(409, `원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- ${bundle.id}`);
      }
      throw new HttpError(400, err.message);
    }
    return { sentenceIds, color: body.color, comment: body.comment };
  }

  async function getNotes(id) {
    const b = await loadPaper(id);
    let sync = { status: 'readonly', pending: 0, message: null, failed: 0, failedMessage: null };
    if (!b.example) {
      writer.resetInfo?.();
      const serverInfo = await getServerInfo(cfg);
      const cards = validated(b).digest?.cards ?? [];
      sync = await syncPaper(out, id, { source: b.source, cards, writer, serverInfo });
    }
    const fresh = await readNotes(out, id); // after sync: reflects pulled annotations
    return {
      highlights: fresh.highlights, cardMemos: fresh.cardMemos, zoteroAnnotations: fresh.zoteroAnnotations,
      note: fresh.note, status: sync.status, pending: sync.pending, message: sync.message,
      failed: sync.failed ?? 0, failedMessage: sync.failedMessage ?? null,
      needsReextract: b.needsReextract,
    };
  }

  // Returns true when the request was handled.
  return async function handle(req, res, parts, method) {
    if (parts[1] === 'zotero' && parts[2] === 'authorize' && parts.length === 3 && method === 'POST') {
      await readBody(req); // content-type guard: blocks cross-origin text/plain form posts
      try {
        const { remember } = await writer.authorize();
        sendJson(res, 200, { ok: true, remember: Boolean(remember) });
      } catch (err) {
        sendJson(res, 200, { ok: false, status: AUTH_STATUSES.has(err?.code) ? err.code : 'offline' });
      }
      return true;
    }
    if (parts[1] !== 'papers' || parts.length < 4) return false;
    const [, , rawId, section, rawSub] = parts;

    if (section === 'notes' && parts.length === 4 && method === 'GET') {
      sendJson(res, 200, await getNotes(checkName(rawId, 'id')));
      return true;
    }

    if (section === 'highlights' && parts.length === 4 && method === 'POST') {
      const id = checkName(rawId, 'id');
      const b = await loadPaper(id, { write: true });
      const h = parseHighlight(await readBody(req), b);
      sendJson(res, 201, await addHighlight(out, id, h));
      return true;
    }

    if (section === 'highlights' && parts.length === 5 && (method === 'PUT' || method === 'DELETE')) {
      const id = checkName(rawId, 'id');
      const hid = checkName(rawSub, '하이라이트 id');
      await loadPaper(id, { write: true });
      if (method === 'DELETE') {
        if (!(await removeHighlight(out, id, hid))) throw new HttpError(404, '하이라이트를 찾을 수 없습니다.');
        res.writeHead(204);
        res.end();
        return true;
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '요청 본문 형식이 올바르지 않습니다.');
      checkStyle(body);
      const h = await updateHighlight(out, id, hid, { color: body.color, comment: body.comment });
      if (!h) throw new HttpError(404, '하이라이트를 찾을 수 없습니다.');
      sendJson(res, 200, h);
      return true;
    }

    if (section === 'card-memos' && parts.length === 5 && method === 'PUT') {
      const id = checkName(rawId, 'id');
      const cardId = checkName(rawSub, '카드 id');
      const b = await loadPaper(id, { write: true });
      const cardIds = new Set((validated(b).digest?.cards ?? []).map((c) => c.id));
      if (!cardIds.has(cardId)) throw new HttpError(404, '요약 카드를 찾을 수 없습니다.');
      const body = await readBody(req);
      if (typeof body?.text !== 'string' || body.text.length > MAX_MEMO) {
        throw new HttpError(400, `text는 ${MAX_MEMO}자 이하의 문자열이어야 합니다.`);
      }
      sendJson(res, 200, { cardId, text: await setCardMemo(out, id, cardId, body.text) });
      return true;
    }

    if (section === 'note-conflict' && parts.length === 4 && method === 'POST') {
      const id = checkName(rawId, 'id');
      await loadPaper(id, { write: true });
      const body = await readBody(req);
      if (body?.choice !== 'overwrite' && body?.choice !== 'keep-zotero') {
        throw new HttpError(400, 'choice는 "overwrite" 또는 "keep-zotero"여야 합니다.');
      }
      await resolveNoteConflict(out, id, body.choice);
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  };
}
