// solo-chat.js — chat panel for push / play pages (same room, mode=solo).

import { showAppAlert } from './ui-alert.js';

export function wireSoloChat(signaling, getMyUserId, { canOpenChat, chatBlockedMessage } = {}) {
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

  // 推/拉流页：聊天面板与流信息互斥，打开聊天时隐藏流信息，关闭后恢复
  const soloInfo = document.querySelector('.solo-info');

  function setChatVisible(visible) {
    chatPanel.classList.toggle('hidden', !visible);
    if (soloInfo) soloInfo.classList.toggle('hidden', !!visible);
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

  chatBtn.addEventListener('click', async () => {
    const open = chatPanel.classList.contains('hidden');
    if (open && typeof canOpenChat === 'function' && !canOpenChat()) {
      await showAppAlert(
        chatBlockedMessage || '请先开始推流或拉流后再使用聊天',
        { title: '无法聊天' },
      );
      return;
    }
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
