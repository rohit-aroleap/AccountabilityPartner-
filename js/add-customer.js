import { addCustomer } from './storage.js';

let modalEl;
const listeners = new Set();

export function onCustomerAdded(fn) {
  listeners.add(fn);
}

export function initAddCustomer() {
  modalEl = document.createElement('div');
  modalEl.id = 'add-customer-modal';
  modalEl.className = 'modal';
  modalEl.innerHTML = `
    <div class="modal-card add-cust-card">
      <div class="modal-header">
        <h2>Add customer</h2>
        <button class="icon-btn" id="ac-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <form id="ac-form">
          <div class="field">
            <label for="ac-name">Name (optional)</label>
            <input type="text" id="ac-name" name="name" placeholder="e.g. Rohit Patel" autocomplete="off" />
            <div class="help">Used in the sidebar and as context in AI prompts. Leave blank to fall back to the name in the Ferra export, then phone number.</div>
          </div>
          <div class="field">
            <label for="ac-phone">Phone number</label>
            <input type="tel" id="ac-phone" name="phone" placeholder="+919876543210" autocomplete="off" required />
            <div class="help">International format with country code. The leading <code>+</code> is added automatically if missing.</div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <span id="ac-status" class="status"></span>
        <button type="button" class="btn-ghost btn" id="ac-cancel">Cancel</button>
        <button type="submit" form="ac-form" class="btn">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  const openBtn = document.getElementById('add-customer-btn');
  if (openBtn) openBtn.addEventListener('click', openModal);
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
  document.getElementById('ac-close').addEventListener('click', closeModal);
  document.getElementById('ac-cancel').addEventListener('click', closeModal);
  document.getElementById('ac-form').addEventListener('submit', onSave);
}

function openModal() {
  document.getElementById('ac-form').reset();
  document.getElementById('ac-status').textContent = '';
  modalEl.classList.add('open');
  setTimeout(() => document.getElementById('ac-name').focus(), 50);
}

function closeModal() {
  modalEl.classList.remove('open');
}

function onSave(e) {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value;
  const phone = f.phone.value;
  const status = document.getElementById('ac-status');
  try {
    const added = addCustomer({ phone, name });
    status.textContent = `Added ${added}`;
    listeners.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
    setTimeout(closeModal, 500);
  } catch (err) {
    status.textContent = err.message;
  }
}
