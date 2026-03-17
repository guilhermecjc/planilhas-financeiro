/**
 * cep_distancia.js — Distância entre CEPs, 100% client-side
 * ─────────────────────────────────────────────────────────────────────────────
 * Sem servidor. Funciona direto no browser / GitHub Pages.
 *
 * Fluxo:
 *   CEP → ViaCEP (endereço) → Nominatim/OSM (lat/lng) → Haversine (distância)
 *
 * COMO INTEGRAR:
 *   Adicione antes do </body> do seu HTML:
 *   <script src="cep_distancia.js"></script>
 *
 * LIMITES GRATUITOS:
 *   • ViaCEP: sem limite documentado
 *   • Nominatim: 1 req/segundo (respeitado automaticamente aqui)
 *   • Sem chaves, sem cadastro, sem servidor
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Cache em localStorage ────────────────────────────────────────────────────
const CEP_CACHE_KEY = 'cf_cep_v2';
const CEP_COORD_CACHE_KEY = 'cf_coord_v2';

const _cepCache = (() => {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(CEP_CACHE_KEY) || '{}'); } catch {}
  return {
    get: k => m[k] || null,
    set: (k, v) => { m[k] = v; try { localStorage.setItem(CEP_CACHE_KEY, JSON.stringify(m)); } catch {} },
  };
})();

const _coordCache = (() => {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(CEP_COORD_CACHE_KEY) || '{}'); } catch {}
  return {
    get: k => m[k] || null,
    set: (k, v) => { m[k] = v; try { localStorage.setItem(CEP_COORD_CACHE_KEY, JSON.stringify(m)); } catch {} },
  };
})();

// ─── Rate limiter para Nominatim (máx 1 req/s) ───────────────────────────────
let _lastNominatim = 0;
async function _nominatimThrottle() {
  const now = Date.now();
  const wait = 1100 - (now - _lastNominatim);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastNominatim = Date.now();
}

// ─── ViaCEP ───────────────────────────────────────────────────────────────────
async function buscarCep(cep) {
  const c = String(cep).replace(/\D/g, '');
  if (c.length !== 8) throw new Error(`CEP inválido: ${cep}`);

  const cached = _cepCache.get(c);
  if (cached) return cached;

  const r = await fetch(`https://viacep.com.br/ws/${c}/json/`);
  if (!r.ok) throw new Error(`ViaCEP indisponível (HTTP ${r.status})`);

  const data = await r.json();
  if (data.erro) throw new Error(`CEP ${c} não encontrado`);

  _cepCache.set(c, data);
  return data;
}

// ─── Geocodificação (Nominatim / OpenStreetMap) ───────────────────────────────
async function geocodificar(cepData) {
  const cidade = cepData.localidade || '';
  const uf     = cepData.uf || '';
  const bairro = cepData.bairro || '';
  const rua    = cepData.logradouro || '';
  const cep    = (cepData.cep || '').replace(/\D/g, '');

  // Chave de cache baseada no CEP
  const cached = _coordCache.get(cep);
  if (cached) return cached;

  await _nominatimThrottle();

  // Tentativa 1: endereço completo
  const q1 = [rua, bairro, cidade, uf, 'Brasil'].filter(Boolean).join(', ');
  let coords = await _nominatimQuery(q1);

  // Tentativa 2: apenas cidade + estado
  if (!coords) {
    await _nominatimThrottle();
    const q2 = [cidade, uf, 'Brasil'].filter(Boolean).join(', ');
    coords = await _nominatimQuery(q2);
  }

  if (!coords) throw new Error(`Não foi possível localizar: ${cidade}/${uf}`);

  _coordCache.set(cep, coords);
  return coords;
}

async function _nominatimQuery(query) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: { 'Accept-Language': 'pt-BR', 'User-Agent': 'CentralFinanceira/1.0' }
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

// ─── Haversine (distância em linha reta, km) ──────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Estimativa de rota (fator empírico sem API key) ─────────────────────────
// Fator 1.35 é a média brasileira de desvio rodoviário (linha reta → estrada)
// Velocidade média urbana/interurbana: 55 km/h
function estimarRota(kmReta) {
  const kmRota = kmReta * 1.35;
  const minutos = Math.round((kmRota / 55) * 60);
  return { rota_km: Math.round(kmRota * 10) / 10, duracao_min: minutos };
}

function formatarDuracao(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// ─── Função principal exportada ───────────────────────────────────────────────
/**
 * Calcula a distância entre dois CEPs.
 *
 * @param {string} cepOrigem
 * @param {string} cepDestino
 * @returns {Promise<{
 *   origem: { cep, logradouro, bairro, cidade, estado, lat, lng },
 *   destino: { cep, logradouro, bairro, cidade, estado, lat, lng },
 *   distancia: { linha_reta_km, rota_km, duracao_min, duracao_formatada }
 * }>}
 */
async function calcularDistanciaCep(cepOrigem, cepDestino) {
  const [dadosO, dadosD] = await Promise.all([
    buscarCep(cepOrigem),
    buscarCep(cepDestino),
  ]);

  // Geocodificação em série para respeitar rate limit do Nominatim
  const coordO = await geocodificar(dadosO);
  const coordD = await geocodificar(dadosD);

  const reta = haversine(coordO.lat, coordO.lng, coordD.lat, coordD.lng);
  const { rota_km, duracao_min } = estimarRota(reta);

  return {
    origem: {
      cep: dadosO.cep,
      logradouro: dadosO.logradouro || '',
      bairro: dadosO.bairro || '',
      cidade: dadosO.localidade || '',
      estado: dadosO.uf || '',
      lat: coordO.lat,
      lng: coordO.lng,
    },
    destino: {
      cep: dadosD.cep,
      logradouro: dadosD.logradouro || '',
      bairro: dadosD.bairro || '',
      cidade: dadosD.localidade || '',
      estado: dadosD.uf || '',
      lat: coordD.lat,
      lng: coordD.lng,
    },
    distancia: {
      linha_reta_km: Math.round(reta * 10) / 10,
      rota_km,
      duracao_min,
      duracao_formatada: formatarDuracao(duracao_min),
    },
  };
}

// ─── Extrai CEP de uma string de endereço ────────────────────────────────────
function extrairCep(texto) {
  if (!texto) return null;
  const m = String(texto).match(/\b(\d{5})-?(\d{3})\b/);
  return m ? m[1] + m[2] : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRAÇÃO COM O MODAL DE DESLOCAMENTO DA CENTRAL FINANCEIRA
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Injeta o botão "📍 Auto KM" no rodapé do modal de deslocamento.
 * Aguarda o modal existir no DOM antes de injetar.
 */
function injetarBotaoAutoKm() {
  const footer = document.querySelector('.desl-footer');
  if (!footer || footer.querySelector('#desl-auto-km-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'desl-auto-km-btn';
  btn.className = 'desl-btn-sec';
  btn.style.cssText = 'background:#e8f0fe;color:#1a73e8;border-color:rgba(26,115,232,.3);';
  btn.innerHTML = '📍 Auto KM';
  btn.title = 'Calcular KM automaticamente pelos CEPs das vistorias';
  btn.onclick = deslAutoKm;

  // Insere antes do botão Calcular (último botão)
  const ultimo = footer.querySelector('.desl-btn-pri');
  footer.insertBefore(btn, ultimo);
}

/**
 * Calcula KM automaticamente para cada vistoria selecionada.
 * Extrai o CEP do campo de origem e do endereço de cada vistoria.
 */
async function deslAutoKm() {
  const btn = document.getElementById('desl-auto-km-btn');

  // Pega o CEP de origem
  const origemVal = (document.getElementById('desl-origem')?.value || '').trim();
  const cepOrigem = extrairCep(origemVal);

  if (!cepOrigem) {
    _alertDesl('⚠️ Informe um CEP válido no campo Origem.\nEx: Rua X, 100 — 13010-111 — Campinas/SP', 'warn');
    return;
  }

  const rows = (typeof filtRows !== 'undefined' && filtRows.length > 0)
    ? filtRows
    : (typeof allRows !== 'undefined' ? allRows : []);

  if (!rows.length) {
    _alertDesl('Nenhuma vistoria carregada.', 'warn');
    return;
  }

  // Verifica se há pelo menos uma vistoria selecionada
  const algumSel = rows.some((_, i) => document.getElementById(`dvc-${i}`)?.checked);
  if (!algumSel) {
    _alertDesl('Selecione ao menos uma vistoria antes de usar o Auto KM.', 'warn');
    return;
  }

  // Botão: estado de carregamento
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span id="akm-spin" style="display:inline-block;width:11px;height:11px;border:2px solid rgba(26,115,232,.25);border-top-color:#1a73e8;border-radius:50%;animation:cf-spin .6s linear infinite;vertical-align:middle;margin-right:5px"></span>Calculando...';
  }

  let ok = 0, sem_cep = 0, erros = 0;

  for (let i = 0; i < rows.length; i++) {
    const cb = document.getElementById(`dvc-${i}`);
    if (!cb?.checked) continue;

    const totEl = document.getElementById(`dvt-${i}`);
    const kmEl  = document.getElementById(`dvk-${i}`);
    if (totEl) totEl.textContent = '⟳';

    // Extrai CEP do endereço da vistoria
    const endStr = [rows[i]?.endereco, rows[i]?.cidade, (rows[i]?.raw || []).join(' ')]
      .filter(Boolean).join(' ');
    const cepDestino = extrairCep(endStr);

    if (!cepDestino) {
      if (totEl) totEl.textContent = '—';
      sem_cep++;
      continue;
    }

    try {
      const dados = await calcularDistanciaCep(cepOrigem, cepDestino);
      const kmIdaVolta = Math.round(dados.distancia.rota_km * 2 * 10) / 10;

      if (kmEl) kmEl.value = kmIdaVolta;

      // Atualiza visuais via funções já existentes no sistema
      if (typeof deslCheck === 'function') deslCheck(i);
      if (typeof deslAtualizarKmTotal === 'function') deslAtualizarKmTotal();

      if (totEl) totEl.textContent = `${kmIdaVolta} km`;
      ok++;
    } catch (e) {
      console.warn(`[AutoKM] vistoria ${i}:`, e.message);
      if (totEl) totEl.textContent = '—';
      erros++;
    }
  }

  // Restaura botão
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '📍 Auto KM';
  }

  // Feedback
  if (ok > 0 && sem_cep === 0 && erros === 0) {
    _alertDesl(`✅ ${ok} vistoria${ok !== 1 ? 's' : ''} com KM calculado!`, 'success');
  } else if (ok > 0) {
    const parts = [`✅ ${ok} calculados`];
    if (sem_cep > 0) parts.push(`⚠️ ${sem_cep} sem CEP no endereço`);
    if (erros > 0)   parts.push(`❌ ${erros} com erro`);
    _alertDesl(parts.join(' · '), 'warn');
  } else {
    _alertDesl('Nenhum CEP encontrado nos endereços. Preencha os KMs manualmente.', 'warn');
  }
}

// ─── Alerta temporário dentro do modal ───────────────────────────────────────
function _alertDesl(msg, tipo = 'warn') {
  const body = document.querySelector('.desl-body');
  if (!body) { alert(msg); return; }

  document.getElementById('_desl_alert')?.remove();

  const cores = {
    success: ['#e6f4ea', 'rgba(24,128,56,.25)',  '#137333'],
    warn:    ['#fff7e6', 'rgba(227,116,0,.3)',    '#b06000'],
    error:   ['#fce8e6', 'rgba(217,48,37,.25)',   '#c5221f'],
  };
  const [bg, border, color] = cores[tipo] || cores.warn;

  const el = document.createElement('div');
  el.id = '_desl_alert';
  el.style.cssText = `background:${bg};border:1px solid ${border};color:${color};border-radius:7px;padding:9px 13px;font-size:12px;line-height:1.5;margin-bottom:12px;`;
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 6000);
}

// ─── CSS da animação de spin ──────────────────────────────────────────────────
if (!document.getElementById('_cep_style')) {
  const s = document.createElement('style');
  s.id = '_cep_style';
  s.textContent = '@keyframes cf-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
}

// ─── Intercepta abertura do modal para injetar o botão ───────────────────────
const _origOpenDesl = window.openDeslocamento;
window.openDeslocamento = function () {
  if (typeof _origOpenDesl === 'function') _origOpenDesl();
  setTimeout(injetarBotaoAutoKm, 60);
};

// ─── API pública (para uso avançado no console ou outros scripts) ─────────────
window.CepDistancia = {
  calcular: calcularDistanciaCep,
  buscarCep,
  extrairCep,
  haversine,
  limparCache() {
    localStorage.removeItem(CEP_CACHE_KEY);
    localStorage.removeItem(CEP_COORD_CACHE_KEY);
    console.info('[CepDistancia] Cache limpo.');
  },
};

console.info('[CepDistancia] Carregado. Uso: CepDistancia.calcular("01310100","20040020")');
