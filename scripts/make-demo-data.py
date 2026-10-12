"""Gera dados de demonstração (reuniões fictícias) em demo-data/ para os prints do README.

Uso: python scripts/make-demo-data.py <arquivo-de-audio.webm>
Depois: npx electron . --user-data=demo-data/profile
"""
import datetime as dt
import json
import os
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'demo-data'))
MEET = os.path.join(ROOT, 'meetings')
PROF = os.path.join(ROOT, 'profile')
AUDIO = sys.argv[1]
STEPS = ['audio', 'transcribe', 'speakers', 'summary']


def iso(d):
    return d.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')  # horário local → UTC


def done(msgs=('', '', '', '')):
    return {k: {'state': 'done', 'progress': 1, 'message': m} for k, m in zip(STEPS, msgs)}


def mk(id_, meta, transcript=None, summary=None):
    d = os.path.join(MEET, id_)
    os.makedirs(d)
    base = {'id': id_, 'titleAuto': False, 'source': 'record', 'tracks': {'mic': True, 'system': True, 'mix': True},
            'audioFile': 'mix.webm', 'markers': [], 'notes': '', 'participants': [], 'speakerNames': {},
            'actions': [], 'chat': [], 'warnings': [], 'error': None}
    base.update(meta)
    with open(os.path.join(d, 'meta.json'), 'w', encoding='utf8') as f:
        json.dump(base, f, ensure_ascii=False, indent=2)
    shutil.copy(AUDIO, os.path.join(d, 'mix.webm'))
    if transcript:
        with open(os.path.join(d, 'transcript.json'), 'w', encoding='utf8') as f:
            json.dump({'segments': transcript}, f, ensure_ascii=False)
    if summary:
        with open(os.path.join(d, 'summary.md'), 'w', encoding='utf8') as f:
            f.write(summary)


shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(MEET)
os.makedirs(PROF)
with open(os.path.join(PROF, 'settings.json'), 'w', encoding='utf8') as f:
    json.dump({'userName': 'Luis', 'storageDir': MEET, 'onboarded': True, 'bridgePort': 47399, 'theme': 'light',
               'localModel': 'large-v3-turbo', 'detectMeetings': False, 'vocabulary': 'PlanMat, SAP HANA, Atlas'},
              f, ensure_ascii=False)

T = [
    (0, 'Ana Souza', 'Bom dia, pessoal! Obrigada por entrarem. Hoje a ideia é fechar o planejamento do quarto trimestre e decidir o que entra no próximo ciclo.'),
    (14, 'Carlos Lima', 'Antes de começar, um ponto de atenção: a integração com o SAP HANA continua bloqueada. A infraestrutura só libera o acesso na quarta-feira.'),
    (31, 'Luis', 'Então vamos seguir com a importação manual até lá. Eu consigo preparar o modelo da planilha hoje à tarde.'),
    (44, 'Ana Souza', 'Perfeito. Carlos, você consegue validar os dados importados antes de sexta?'),
    (52, 'Carlos Lima', 'Consigo, sim. Só preciso do acesso de leitura ao ambiente de homologação.'),
    (63, 'Mariana Alves', 'Eu libero esse acesso ainda hoje. Sobre o orçamento: o financeiro aprovou cento e vinte mil para o trimestre, com dez por cento de reserva.'),
    (81, 'Ana Souza', 'Ótimo. Então as prioridades ficam: primeiro o novo onboarding, depois o painel de indicadores e, se sobrar tempo, a exportação em PDF.'),
    (98, 'Luis', 'Concordo. Sugiro mover a exportação em PDF para o primeiro trimestre do ano que vem, para não apertar o time.'),
    (110, 'Mariana Alves', 'Faz sentido. Fica registrado como decisão: exportação em PDF sai do escopo do Q4.'),
    (124, 'Carlos Lima', 'Um risco que vejo é a migração do banco no meio de novembro. Se atrasar, o painel de indicadores atrasa junto.'),
    (139, 'Ana Souza', 'Bem lembrado. Luis, você pode montar um plano B para o painel usando a base atual?'),
    (147, 'Luis', 'Posso. Mando o cronograma atualizado para todos até amanhã, já com esse plano B.'),
    (160, 'Ana Souza', 'Fechado. Próxima reunião de acompanhamento na segunda às dez. Obrigada a todos!'),
]
tr = [{'start': s, 'end': (T[i + 1][0] - 0.5 if i + 1 < len(T) else s + 8), 'text': t, 'speaker': w,
       'source': 'mic' if w == 'Luis' else 'system'} for i, (s, w, t) in enumerate(T)]

SUMMARY = """📋 PLANEJAMENTO DO Q4 — TIME DE PRODUTO
📅 12/10/2026 · 09:00 (BRT) · ~47 min
👥 Participantes: Ana Souza, Carlos Lima, Mariana Alves, Luis

━━━━━━━━━━━━━━━━━━━━
📝 RESUMO
━━━━━━━━━━━━━━━━━━━━

▸ Integração SAP HANA: importação manual até a liberação do acesso
• Bloqueio: a infraestrutura só libera o acesso ao SAP HANA na quarta-feira (Carlos).
• Solução de contorno: dados importados manualmente via planilha até lá.
• Prazo: validação dos dados importados pelo Carlos até sexta-feira.
• Mariana libera hoje o acesso de leitura ao ambiente de homologação.

▸ Orçamento do Q4 aprovado
• Valor: R$ 120 mil para o trimestre, com 10% de reserva (Mariana).

▸ Prioridades do próximo ciclo
• Ordem definida: 1) novo onboarding, 2) painel de indicadores, 3) exportação em PDF.
• Decisão: exportação em PDF sai do escopo do Q4 e vai para o Q1 de 2027.

▸ Riscos
• Migração do banco em meados de novembro pode atrasar o painel de indicadores (Carlos).
• Luis montará um plano B para o painel usando a base atual.

━━━━━━━━━━━━━━━━━━━━
✅ ITENS DE AÇÃO
━━━━━━━━━━━━━━━━━━━━

☐ Luis: preparar o modelo da planilha de importação manual (hoje à tarde).
☐ Carlos Lima: validar os dados importados até sexta-feira.
☐ Mariana Alves: liberar acesso de leitura à homologação para o Carlos (hoje).
☐ Luis: enviar o cronograma atualizado com o plano B do painel até amanhã.
"""

actions = [
    {'owner': 'Luis', 'text': 'preparar o modelo da planilha de importação manual (hoje à tarde).', 'done': True},
    {'owner': 'Carlos Lima', 'text': 'validar os dados importados até sexta-feira.', 'done': False},
    {'owner': 'Mariana Alves', 'text': 'liberar acesso de leitura à homologação para o Carlos (hoje).', 'done': True},
    {'owner': 'Luis', 'text': 'enviar o cronograma atualizado com o plano B do painel até amanhã.', 'done': False},
]
day = dt.datetime(2026, 10, 12)

mk('2026-10-12_090000', {
    'title': 'Planejamento do Q4 — Time de Produto', 'createdAt': iso(day.replace(hour=9)), 'duration': 2834,
    'status': 'ready', 'platform': 'Teams (navegador)', 'participants': ['Ana Souza', 'Carlos Lima', 'Mariana Alves', 'Luis'],
    'steps': done(['Áudio pronto · 47:14', '812 trechos transcritos com Whisper local (large-v3-turbo)',
                   '746 falas identificadas por nome · 23 ecos removidos', 'Resumo gerado em 21s · 4 itens de ação']),
    'actions': actions, 'markers': [{'t': 63, 'label': 'Orçamento aprovado'}, {'t': 110, 'label': 'Decisão: PDF fora do Q4'}],
    'notes': 'Confirmar com a Mariana a reserva de 10%.',
    'summary': {'generatedAt': iso(day.replace(hour=9, minute=49)), 'model': 'claude-opus-5-5', 'durationMs': 21000, 'costUsd': 0.084},
    'chat': [
        {'role': 'user', 'text': 'O que ficou pendente para mim?'},
        {'role': 'assistant', 'text': 'Você ficou com duas entregas:\n• Preparar o modelo da planilha de importação manual — hoje à tarde [00:31]\n• Enviar o cronograma atualizado, já com o plano B do painel de indicadores, até amanhã [02:27]'},
    ],
}, tr, SUMMARY)
mk('2026-10-12_083000', {'title': 'Daily de engenharia', 'createdAt': iso(day.replace(hour=8, minute=30)), 'duration': 912,
                         'status': 'ready', 'platform': 'Microsoft Teams', 'participants': ['Carlos Lima', 'Bruno Rocha', 'Luis'],
                         'steps': done(), 'actions': [{'owner': 'Bruno Rocha', 'text': 'corrigir o build da branch de pagamentos', 'done': False}]},
   None, '📋 DAILY DE ENGENHARIA')
mk('2026-10-11_163000', {'title': 'Alinhamento com cliente — Projeto Atlas', 'createdAt': iso(dt.datetime(2026, 10, 11, 16, 30)),
                         'duration': 3125, 'status': 'recorded', 'platform': 'Zoom',
                         'steps': {k: {'state': 'pending', 'progress': 0, 'message': ''} for k in STEPS}})
mk('2026-10-11_140000', {'title': '1:1 com a Mariana', 'createdAt': iso(dt.datetime(2026, 10, 11, 14, 0)), 'duration': 1780,
                         'status': 'ready', 'platform': 'Google Meet', 'participants': ['Mariana Alves', 'Luis'], 'steps': done(),
                         'actions': [{'owner': 'Luis', 'text': 'revisar metas', 'done': False}, {'owner': 'Mariana Alves', 'text': 'enviar feedback', 'done': False}]},
   None, '📋 1:1')
mk('2026-10-07_100000', {'title': 'Entrevista — Desenvolvedor(a) Sênior', 'createdAt': iso(dt.datetime(2026, 10, 7, 10, 0)), 'duration': 2410,
                         'status': 'ready', 'source': 'import', 'participants': ['Ana Souza', 'Rafael Costa', 'Luis'], 'steps': done()},
   None, '📋 ENTREVISTA')
print('Dados de demonstração em', ROOT)
