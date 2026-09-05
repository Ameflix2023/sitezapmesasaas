fetch('/api/firebase-status')
  .then((response) => response.json())
  .then(({ connected }) => {
    document.documentElement.dataset.firebaseConnected = String(connected === true);
  })
  .catch(() => {
    document.documentElement.dataset.firebaseConnected = 'false';
  });

const drawerOpenButton = document.querySelector('[data-drawer-open]');
const drawerCloseButtons = document.querySelectorAll('[data-drawer-close]');
const drawer = document.querySelector('#drawer');
let dragStartX = 0;
let dragOffset = 0;
let isDragging = false;
const connectionActions = document.querySelectorAll('[data-connection-action]');

async function monitorConnection(card, instanceName) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetch(`/api/evolution/instances/${encodeURIComponent(instanceName)}/state`);
    const result = await response.json();
    const state = result.data?.instance?.state || result.data?.state;

    if (state === 'open') {
      const action = card.querySelector('[data-connection-action]');
      card.querySelector('[data-connection-status]').textContent = 'Conectado';
      card.querySelector('.status-indicator').classList.add('status-indicator--ready');
      card.querySelector('[data-qr-result]').hidden = true;
      action.outerHTML = `<button class="connection-action connection-action--disconnect" type="button" data-disconnect-action="${encodeURIComponent(instanceName)}"><span class="button-mark" aria-hidden="true">−</span><span>Desconectar WhatsApp</span></button>`;
      return;
    }
  }
}

function setDrawerState(isOpen) {
  document.body.classList.toggle('drawer-open', isOpen);
  drawer.setAttribute('aria-hidden', String(!isOpen));
  drawerOpenButton.setAttribute('aria-expanded', String(isOpen));
  if (!isOpen) {
    drawerOpenButton.focus();
  }
}

drawerOpenButton.addEventListener('click', () => setDrawerState(true));
drawerCloseButtons.forEach((button) => button.addEventListener('click', () => setDrawerState(false)));

drawer.addEventListener('pointerdown', (event) => {
  if (!document.body.classList.contains('drawer-open')) return;
  dragStartX = event.clientX;
  dragOffset = 0;
  isDragging = true;
  drawer.classList.add('is-dragging');
  drawer.setPointerCapture(event.pointerId);
});

drawer.addEventListener('pointermove', (event) => {
  if (!isDragging) return;
  dragOffset = Math.min(0, event.clientX - dragStartX);
  drawer.style.transform = `translateX(${dragOffset}px)`;
});

function finishDrawerDrag(event) {
  if (!isDragging) return;
  isDragging = false;
  drawer.classList.remove('is-dragging');
  if (drawer.hasPointerCapture(event.pointerId)) {
    drawer.releasePointerCapture(event.pointerId);
  }

  if (dragOffset < -(drawer.offsetWidth * 0.25)) {
    drawer.style.transform = '';
    setDrawerState(false);
  } else {
    drawer.style.transform = '';
  }
}

drawer.addEventListener('pointerup', finishDrawerDrag);
drawer.addEventListener('pointercancel', finishDrawerDrag);
document.addEventListener('pointerup', finishDrawerDrag);
document.addEventListener('pointercancel', finishDrawerDrag);

connectionActions.forEach((action) => {
  action.addEventListener('click', async () => {
    const card = action.closest('.connection-card');
    const status = card.querySelector('.connection-status');
    const indicator = card.querySelector('.status-indicator');
    const statusText = card.querySelector('[data-connection-status]');
    const buttonLabel = card.querySelector('[data-connection-label]');
    const qrResult = card.querySelector('[data-qr-result]');
    const qrImage = card.querySelector('[data-qr-image]');

    card.classList.remove('connection-card--invalid');
    qrResult.hidden = true;
    action.disabled = true;
    buttonLabel.textContent = 'Gerando QR Code...';
    statusText.textContent = 'Preparando conexão';

    try {
      if (window.location.protocol === 'file:') {
        throw new Error('Abra o painel em http://localhost:3000 para conectar o WhatsApp.');
      }

      const response = await fetch('/api/evolution/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Não foi possível criar a instância.');
      }

      statusText.textContent = 'Aguardando leitura';
      indicator.classList.add('status-indicator--ready');
      buttonLabel.textContent = 'Gerar novo QR Code';

      const qrValue = result.data?.qrcode?.base64
        || result.data?.qrcode?.code
        || result.data?.qrCode
        || result.data?.base64
        || result.qrcode?.base64
        || result.qrcode?.code
        || result.qrCode
        || result.base64
        || result.data?.qr?.base64;

      if (typeof qrValue === 'string' && qrResult && qrImage) {
        qrImage.src = qrValue.startsWith('data:image')
          ? qrValue
          : `data:image/png;base64,${qrValue}`;
        qrResult.hidden = false;
        const instanceName = result.data?.instance?.instanceName;
        if (instanceName) {
          monitorConnection(card, instanceName).catch(() => {});
        }
      } else {
        throw new Error('A API não retornou um QR Code para esta conexão.');
      }
    } catch (error) {
      statusText.textContent = error.message === 'Unauthorized'
        ? 'API recusou o acesso'
        : error.message.startsWith('Abra o painel')
          ? 'Servidor não iniciado'
        : 'Não conectado';
      indicator.classList.remove('status-indicator--ready');
      buttonLabel.textContent = 'Tentar novamente';
      card.classList.add('connection-card--invalid');
    } finally {
      action.disabled = false;
    }
  });
});

document.addEventListener('click', async (event) => {
  const disconnectAction = event.target.closest('[data-disconnect-action]');
  if (!disconnectAction) return;

  disconnectAction.disabled = true;
  disconnectAction.querySelector('span:last-child').textContent = 'Desconectando...';

  try {
    const instanceName = decodeURIComponent(disconnectAction.dataset.disconnectAction);
    const response = await fetch(`/api/evolution/instances/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Não foi possível desconectar o WhatsApp.');
    }

    window.location.reload();
  } catch (error) {
    disconnectAction.disabled = false;
    disconnectAction.querySelector('span:last-child').textContent = 'Desconectar WhatsApp';
    alert(error.message);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) {
    setDrawerState(false);
  }
});
