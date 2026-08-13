const { invoke } = window.__TAURI__.core

const listEl = document.getElementById("vault-list")
const emptyEl = document.getElementById("empty")
const statusEl = document.getElementById("status")
const addBtn = document.getElementById("add-vault")

function setStatus(message, isError) {
  statusEl.textContent = message ?? ""
  statusEl.classList.toggle("error", Boolean(isError))
}

function setBusy(busy) {
  addBtn.disabled = busy
  for (const btn of listEl.querySelectorAll("button")) btn.disabled = busy
}

async function openVault(id) {
  setBusy(true)
  setStatus("Starting vault runtime…")
  try {
    const opened = await invoke("open_vault", { id })
    setStatus(`Ready on port ${opened.port}. Loading…`)
    window.location.href = `http://127.0.0.1:${opened.port}/`
  } catch (err) {
    setBusy(false)
    setStatus(String(err), true)
  }
}

async function removeVault(id, event) {
  event.stopPropagation()
  setBusy(true)
  try {
    await invoke("remove_vault", { id })
    await render()
  } catch (err) {
    setStatus(String(err), true)
  } finally {
    setBusy(false)
  }
}

async function revealVault(id, event) {
  event.stopPropagation()
  try {
    await invoke("reveal_vault", { id })
  } catch (err) {
    setStatus(String(err), true)
  }
}

function vaultRow(entry) {
  const li = document.createElement("li")
  li.className = "vault-row"

  const meta = document.createElement("div")
  meta.className = "meta"
  const name = document.createElement("div")
  name.className = "name"
  name.textContent = entry.name
  const path = document.createElement("div")
  path.className = "path"
  path.textContent = entry.path
  meta.append(name, path)

  const actions = document.createElement("div")
  actions.className = "actions"
  const revealBtn = document.createElement("button")
  revealBtn.className = "subtle"
  revealBtn.textContent = "Reveal"
  revealBtn.onclick = (e) => revealVault(entry.id, e)
  const removeBtn = document.createElement("button")
  removeBtn.className = "subtle"
  removeBtn.textContent = "Remove"
  removeBtn.onclick = (e) => removeVault(entry.id, e)
  actions.append(revealBtn, removeBtn)

  li.append(meta, actions)
  li.onclick = () => openVault(entry.id)
  return li
}

async function render() {
  setStatus("")
  const registry = await invoke("list_vaults")
  listEl.innerHTML = ""
  emptyEl.hidden = registry.vaults.length > 0
  for (const entry of registry.vaults) listEl.append(vaultRow(entry))
  return registry
}

async function bootstrap() {
  setStatus("Loading…")
  const registry = await render()
  if (registry.activeVaultId && registry.vaults.some((v) => v.id === registry.activeVaultId)) {
    await openVault(registry.activeVaultId)
  } else {
    setStatus("")
  }
}

addBtn.addEventListener("click", async () => {
  setBusy(true)
  setStatus("")
  try {
    const entry = await invoke("add_vault_via_dialog")
    if (entry) {
      await render()
      await openVault(entry.id)
      return
    }
  } catch (err) {
    setStatus(String(err), true)
  } finally {
    setBusy(false)
  }
})

bootstrap()
