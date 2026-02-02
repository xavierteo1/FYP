(function () {
  const cfg = window.__PAYPAL_CFG__;
  if (!cfg || !cfg.required) return;

  let paymentDone = false;

  const modalEl = document.getElementById('paypalModal');
  const statusEl = document.getElementById('paypalStatus');
  const btnWrap = document.getElementById('paypalButtons');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  // Force modal open (Bootstrap 5)
  const modal = new bootstrap.Modal(modalEl, {
    backdrop: 'static',
    keyboard: false
  });

  // Prevent closing until paid
  modalEl.addEventListener('hide.bs.modal', (e) => {
    if (!paymentDone) e.preventDefault();
  });

  modal.show();
  setStatus(`You need to pay $${Number(cfg.amount).toFixed(2)} to proceed.`);

  if (!window.paypal) {
    setStatus('PayPal SDK not loaded. Check client ID.');
    return;
  }

  // Render buttons
  window.paypal.Buttons({
    style: { layout: 'vertical' },

    createOrder: function () {
      setStatus('Creating PayPal order...');
      return fetch(`/chats/${cfg.chatId}/paypal/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
        .then(r => r.json())
        .then(data => {
          if (!data.ok) throw new Error(data.error || 'create-order failed');
          setStatus('Order created. Waiting for approval...');
          return data.orderID;
        })
        .catch(err => {
          console.error(err);
          setStatus(`Failed to create order: ${err.message}`);
          throw err;
        });
    },

    onApprove: function (data) {
      setStatus('Capturing payment...');
      return fetch(`/chats/${cfg.chatId}/paypal/capture-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderID: data.orderID })
      })
        .then(r => r.json())
        .then(resp => {
          if (!resp.ok) throw new Error(resp.error || 'capture failed');
          paymentDone = true;
          setStatus('Payment successful. Refreshing...');
          window.location.reload();
        })
        .catch(err => {
          console.error(err);
          setStatus(`Payment capture failed: ${err.message}`);
        });
    },

    onError: function (err) {
      console.error(err);
      setStatus('PayPal error occurred. Please try again.');
    }
  }).render(btnWrap);
})();
