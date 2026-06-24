// solo-chat.js — chat panel for push / play pages (same room, mode=solo).

export function wireSoloChat(signaling, getMyUserId) {
  const chatPanel = document.getElementById('chatPanel');
  const chatLog = document.getElementById('chatLog');
  const chatInput = document.getElementById('chatInput');
  const chatBtn = document.getElementById('btnChat');
  const chatForm = document.getElementById('chatForm');
  const chatClose = document.getElementById('chatClose');
  if (!chatPanel || !chatLog || !chatInput || !chatBtn || !chatForm) return;

  function isChatOpen() {
    return !chatPanel.classList.contains('hidden');
  }

  function setChatUnread(unread) {
    chatBtn.classList.toggle('has-unread', !!unread);
  }

  function setChatVisible(visible) {
    chatPanel.classList.toggle('hidden', !visible);
    if (visible) {
      chatInput.focus();
      setChatUnread(false);
    }
  }

  function appendChat({ nickname, text, ts, isMe }) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (isMe ? ' me' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = ts ? new Date(ts) : new Date();
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    meta.textContent = `${nickname} · ${hh}:${mm}`;
    const body = document.createElement('div');
    body.textContent = text;
    wrap.appendChild(meta);
    wrap.appendChild(body);
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  signaling.on('chat', (p) => {
    const isMe = p.from === getMyUserId();
    appendChat({ nickname: p.nickname, text: p.text, ts: p.ts, isMe });
    if (!isMe && !isChatOpen()) setChatUnread(true);
  });

  chatBtn.addEventListener('click', () => {
    const open = chatPanel.classList.contains('hidden');
    setChatVisible(open);
    chatBtn.classList.toggle('active', open);
  });

  chatClose?.addEventListener('click', () => {
    setChatVisible(false);
    chatBtn.classList.remove('active');
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = chatInput.value.trim();
    if (!txt) return;
    signaling.send('chat', { text: txt });
    chatInput.value = '';
  });
}
