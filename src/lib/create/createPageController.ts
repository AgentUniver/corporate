import { initWizardController } from './wizardController';
import { initIngressController } from './ingressController';
import { initGenerateController } from './generateController';

export function initCreatePage() {
  const viewChoice = document.getElementById('view-choice');
  const viewConnect = document.getElementById('view-connect-wizard');
  const viewGenerate = document.getElementById('view-generate-flow');
  const viewIngress = document.getElementById('view-ingress-flow');

  const startConnectBtn = document.getElementById('start-connect-btn');
  const startGenerateBtn = document.getElementById('start-generate-btn');
  const btnBackFromGen = document.getElementById('btn-back-from-gen');
  const startIngressBtn = document.getElementById('start-ingress-btn');
  const btnBackFromIngress = document.getElementById('btn-back-from-ingress');

  const wizard = initWizardController();
  initIngressController();
  initGenerateController();

  startConnectBtn?.addEventListener('click', () => {
    viewChoice?.classList.add('hidden');
    viewConnect?.classList.remove('hidden');
    wizard.goToStep(1);
  });

  startGenerateBtn?.addEventListener('click', () => {
    viewChoice?.classList.add('hidden');
    viewGenerate?.classList.remove('hidden');
  });

  btnBackFromGen?.addEventListener('click', () => {
    viewGenerate?.classList.add('hidden');
    viewChoice?.classList.remove('hidden');
  });

  startIngressBtn?.addEventListener('click', () => {
    viewChoice?.classList.add('hidden');
    viewIngress?.classList.remove('hidden');
  });

  btnBackFromIngress?.addEventListener('click', () => {
    viewIngress?.classList.add('hidden');
    viewChoice?.classList.remove('hidden');
  });
}
