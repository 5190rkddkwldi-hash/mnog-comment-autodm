/**
 * 므노그 인스타그램 댓글 -> 대댓글 + DM 자동화
 *
 * Meta 공식 Instagram API (graph.instagram.com) 사용.
 * GitHub Actions 크론에서 5분마다 실행되므로 로컬 PC 전원과 무관하게 동작한다.
 *
 * 환경변수: IG_TOKEN (60일 장기 액세스 토큰)
 */
const fs = require('fs');
const path = require('path');

const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_TOKEN;
if (!TOKEN) {
  console.error('IG_TOKEN 환경변수가 없습니다.');
  process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(pathname, { method = 'GET', params = {}, body = null } = {}) {
  const url = new URL(API + pathname);
  url.searchParams.set('access_token', TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const opts = { method };
  if (body) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status + ' ' + pathname + ' :: ' + JSON.stringify(json.error || json).slice(0, 300));
  }
  return json;
}

const getComments = (mediaId) =>
  call('/' + mediaId + '/comments', {
    params: { fields: 'id,text,username,timestamp,replies{id}', limit: 50 },
  });

const replyToComment = (commentId, message) =>
  call('/' + commentId + '/replies', { method: 'POST', params: { message } });

// Private Reply: 댓글 작성자에게 DM 발송.
// Meta 정책상 댓글 1건당 1회, 댓글 작성 후 7일 이내만 허용된다.
const sendPrivateReply = (commentId, text) =>
  call('/me/messages', {
    method: 'POST',
    body: { recipient: { comment_id: commentId }, message: { text } },
  });

const loadJSON = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
};

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
const matches = (text, keywords) => keywords.some((k) => norm(text).includes(norm(k)));

async function main() {
  const cfg = loadJSON(CONFIG_PATH, null);
  if (!cfg) throw new Error('config.json 을 읽을 수 없습니다.');
  const state = loadJSON(STATE_PATH, { processed: {} });

  const report = [];
  let handled = 0;

  for (const auto of cfg.automations.filter((a) => a.enabled)) {
    const done = new Set(state.processed[auto.mediaId] || []);

    let comments;
    try {
      comments = (await getComments(auto.mediaId)).data || [];
    } catch (e) {
      report.push('[' + auto.id + '] 댓글 조회 실패: ' + e.message);
      continue;
    }

    const targets = comments.filter((c) => {
      if (done.has(c.id)) return false;
      if (c.username === cfg.account) return false;                     // 내가 쓴 댓글은 무시
      if (c.replies && c.replies.data && c.replies.data.length) return false; // 이미 답글이 달림
      if (!matches(c.text, auto.keywords)) return false;
      const ageDays = (Date.now() - new Date(c.timestamp).getTime()) / 86400000;
      return ageDays <= 6.5;                                            // 7일 창을 넘기면 DM 불가
    });

    for (const c of targets) {
      if (handled >= cfg.maxPerRun) break;

      let dmOk = false;
      let replyOk = false;

      try {
        await sendPrivateReply(c.id, auto.dmText);
        dmOk = true;
      } catch (e) {
        report.push('[' + auto.id + '] ' + c.id + ' DM 실패: ' + e.message);
      }

      await sleep(2000);

      try {
        const tpl = auto.replyTemplates[Math.floor(Math.random() * auto.replyTemplates.length)];
        await replyToComment(c.id, tpl);
        replyOk = true;
      } catch (e) {
        report.push('[' + auto.id + '] ' + c.id + ' 대댓글 실패: ' + e.message);
      }

      // 처리 기록은 건별로 즉시 저장해서 중복 발송을 막는다
      if (!state.processed[auto.mediaId]) state.processed[auto.mediaId] = [];
      state.processed[auto.mediaId].push(c.id);
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

      handled += 1;
      report.push(
        '[' + auto.id + '] ' + c.id + ' -> DM:' + (dmOk ? 'OK' : 'FAIL') + ' 대댓글:' + (replyOk ? 'OK' : 'FAIL')
      );

      // 스팸 감지 회피: 사람 사이 20~40초 간격
      if (handled < targets.length) await sleep(20000 + Math.floor(Math.random() * 20000));
    }
  }

  console.log(report.length ? report.join('\n') : '새로 처리할 키워드 댓글 없음');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
