// À REMPLIR par l'organisateur après avoir déployé le script Google (voir docs/INSTALLATION.md).
export const CONFIG = {
  // URL du déploiement "Application Web" du script Google Apps Script (se termine par /exec)
  uploadUrl: 'https://script.google.com/macros/s/AKfycby-iaVHNOyv6n_nDoXT23HWJXwQw-x7hKL4Otd2cVtPZ23jdeFnVFa-SEA5sRVK_ZFgrA/exec',
  // Même clé que KEY dans apps-script/Code.gs (évite que n'importe qui dépose des fichiers)
  uploadKey: 'gq360-D4V6lQUFeiTDT4ffM7FVC2xi',
  // Largeur de la photo 360 assemblée sur le téléphone (hauteur = moitié). 4096 = bon compromis.
  panoWidth: 4096,
  // Envoyer aussi les photos sources (permet de refaire une version HD sur ordinateur).
  sendSourcesDefault: true,
};

// Pour les tests en local uniquement : localStorage.gq2_dev_upload = '{"uploadUrl":"…","uploadKey":"…"}'
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  try { Object.assign(CONFIG, JSON.parse(localStorage.getItem('gq2_dev_upload') || '{}')); } catch {}
}
