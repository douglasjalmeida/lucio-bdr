"""Gera relatorio semanal do Lucio pro Brunno em PDF."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.colors import HexColor, black, white
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY

OUT = "/Users/douglasalmeida/iA/lucio-bdr/docs/relatorio-semanal-lucio-2026-05-14.pdf"

LUMINUS_AZUL = HexColor("#1B3A6B")
LUMINUS_LARANJA = HexColor("#F39C12")
CINZA = HexColor("#555555")
CINZA_CLARO = HexColor("#EEEEEE")

doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm,
    topMargin=1.8*cm, bottomMargin=1.8*cm,
    title="Relatorio Semanal Lucio BDR",
    author="Douglas Almeida - CMO Partner Luminus",
)

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"],
    fontName="Helvetica-Bold", fontSize=18, textColor=LUMINUS_AZUL,
    spaceAfter=6, spaceBefore=0)
H2 = ParagraphStyle("H2", parent=styles["Heading2"],
    fontName="Helvetica-Bold", fontSize=13, textColor=LUMINUS_AZUL,
    spaceAfter=4, spaceBefore=10)
H3 = ParagraphStyle("H3", parent=styles["Heading3"],
    fontName="Helvetica-Bold", fontSize=11, textColor=black,
    spaceAfter=2, spaceBefore=6)
BODY = ParagraphStyle("Body", parent=styles["Normal"],
    fontName="Helvetica", fontSize=10, textColor=black, leading=14,
    alignment=TA_JUSTIFY, spaceAfter=4)
BULLET = ParagraphStyle("Bullet", parent=BODY,
    leftIndent=14, bulletIndent=2, spaceAfter=2)
SUB = ParagraphStyle("Sub", parent=styles["Normal"],
    fontName="Helvetica-Oblique", fontSize=9, textColor=CINZA, spaceAfter=8)
CAPTION = ParagraphStyle("Caption", parent=styles["Normal"],
    fontName="Helvetica", fontSize=9, textColor=CINZA, spaceAfter=2)

story = []

# === CAPA / HEADER ===
story.append(Paragraph("Lucio BDR &mdash; Relatorio Semanal", H1))
story.append(Paragraph("Semana de 11 a 14 de maio de 2026", SUB))

cab = Table([
    ["Para:", "Brunno Garcia (CEO/COO Luminus)"],
    ["De:", "Douglas Almeida (CMO Partner)"],
    ["Assunto:", "Status do agente Lucio &mdash; entregas da semana"],
    ["Data:", "14/05/2026"],
], colWidths=[2.5*cm, 13*cm])
cab.setStyle(TableStyle([
    ("FONT", (0,0), (0,-1), "Helvetica-Bold", 9),
    ("FONT", (1,0), (1,-1), "Helvetica", 9),
    ("TEXTCOLOR", (0,0), (-1,-1), black),
    ("BOTTOMPADDING", (0,0), (-1,-1), 3),
    ("TOPPADDING", (0,0), (-1,-1), 3),
    ("LINEBELOW", (0,-1), (-1,-1), 0.5, LUMINUS_AZUL),
]))
story.append(cab)
story.append(Spacer(1, 14))

# === RESUMO EXECUTIVO ===
story.append(Paragraph("Resumo executivo", H2))
story.append(Paragraph(
    "Em 4 dias uteis o Lucio saiu de prototipo isolado para <b>agente comercial "
    "rodando em producao</b>, com CRM espelhado no Chatwoot, handoff automatico "
    "para closer humano, devolucao supervisionada de volta ao bot e base de "
    "obras (1.155 obras / 379 leads) carregada para alimentar a cadencia. "
    "O motor esta operacional &mdash; falta apenas o teste E2E final com "
    "telefone real antes de liberar volume.",
    BODY,
))
story.append(Spacer(1, 6))

# Indicadores rapidos
ind = Table([
    ["13", "8", "1.155", "379"],
    ["entregas\nde codigo", "novos\nrecursos", "obras\nimportadas", "leads\nqualificaveis"],
], colWidths=[3.7*cm]*4)
ind.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), LUMINUS_AZUL),
    ("TEXTCOLOR", (0,0), (-1,0), white),
    ("FONT", (0,0), (-1,0), "Helvetica-Bold", 22),
    ("BACKGROUND", (0,1), (-1,1), CINZA_CLARO),
    ("FONT", (0,1), (-1,1), "Helvetica", 8),
    ("TEXTCOLOR", (0,1), (-1,1), CINZA),
    ("ALIGN", (0,0), (-1,-1), "CENTER"),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING", (0,0), (-1,0), 10),
    ("BOTTOMPADDING", (0,0), (-1,0), 10),
    ("TOPPADDING", (0,1), (-1,1), 6),
    ("BOTTOMPADDING", (0,1), (-1,1), 6),
]))
story.append(ind)
story.append(Spacer(1, 14))

# === O QUE FOI ENTREGUE ===
story.append(Paragraph("O que foi entregue", H2))

# Bloco 1: Chatwoot
story.append(Paragraph("1. Integracao com Chatwoot (CRM espelho)", H3))
story.append(Paragraph(
    "Toda conversa que o Lucio tem no WhatsApp agora aparece em tempo real no "
    "Chatwoot. O closer humano trabalha 100% pelo Chatwoot &mdash; nao precisa "
    "abrir WhatsApp Web nem trocar de ferramenta.",
    BODY,
))
for item in [
    "Sincronizacao automatica de contato, conversa e mensagens (bot + cliente)",
    "Qualificador automatico classifica lead em MQL (interesse) ou SQL (pronto pra fechar)",
    "Quando vira SQL, Lucio passa pro time de Closers com nota privada de contexto",
    "Anti-loop: mensagens espelhadas nao sao reenviadas pro WhatsApp",
]:
    story.append(Paragraph(f"&bull; {item}", BULLET))

# Bloco 2: Handoff bidirecional
story.append(Paragraph("2. Handoff humano &mdash; ida e volta", H3))
story.append(Paragraph(
    "O closer pode assumir uma conversa a qualquer momento (Lucio fica em "
    "modo mudo). Quando o closer terminar, basta aplicar a label "
    "<b>devolver-lucio</b> no Chatwoot e o Lucio retoma o atendimento &mdash; "
    "com todo o contexto que o closer escreveu em notas privadas.",
    BODY,
))
for item in [
    "Closer assume: Lucio para de responder mas continua gravando tudo",
    "Notas privadas do closer viram contexto pro Lucio (ex.: \"cliente prefere ligar no fim do dia\")",
    "Devolucao manual: label <b>devolver-lucio</b> -&gt; bot volta a falar",
    "<b>Watchdog automatico:</b> se o humano sumir por 1 hora, Lucio reassume sozinho",
]:
    story.append(Paragraph(f"&bull; {item}", BULLET))

# Bloco 3: Cadência
story.append(Paragraph("3. Cadencia comercial calibrada", H3))
story.append(Paragraph(
    "Estrategia de toque ajustada apos revisao: <b>1 toque so</b>, mais "
    "humanizado, sem cara de robo de telemarketing. Janela 08h00-17h30 em "
    "dias uteis, com jitter de 3-8 minutos entre disparos pra preservar a "
    "reputacao do chip WhatsApp.",
    BODY,
))

# Bloco 4: Base de obras
story.append(Paragraph("4. Base de obras &mdash; combustivel da prospeccao", H3))
story.append(Paragraph(
    "Importacao e classificacao automatica de <b>1.155 obras</b> ativas, que "
    "se consolidaram em <b>379 leads unicos de alta qualidade</b>. Esses 379 "
    "nao sao a lista bruta &mdash; sao o resultado de cruzamento e "
    "deduplicacao por telefone (matriz com varias obras vira um lead so) "
    "e da classificacao automatica que identifica se a empresa e construtora, "
    "incorporadora ou ambas. <b>Cada lead carrega o dossie da(s) obra(s) "
    "associada(s)</b> (nome, localizacao, etapa, tipo de empreendimento), e "
    "o Lucio usa essas informacoes na hora da abordagem &mdash; ele nao chega "
    "como vendedor generico, chega ja sabendo que a empresa toca \"a obra X "
    "em Y\", o que abre conversa com taxa de resposta muito maior.",
    BODY,
))

ob = Table([
    ["Tipo", "Volume", "Uso comercial"],
    ["Construtoras", "128", "Gerador de canteiro + MPaaS apos entrega"],
    ["Incorporadoras", "108", "Padrao + MPaaS recorrente"],
    ["Ambas", "22", "Conta-chave: gerador + locacao + MPaaS"],
    ["Indefinidos", "123", "Triagem manual antes do toque"],
    ["Total leads", "379", "&mdash;"],
], colWidths=[4*cm, 2.5*cm, 9*cm])
ob.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), LUMINUS_AZUL),
    ("TEXTCOLOR", (0,0), (-1,0), white),
    ("FONT", (0,0), (-1,0), "Helvetica-Bold", 9),
    ("FONT", (0,1), (-1,-1), "Helvetica", 9),
    ("FONT", (0,-1), (-1,-1), "Helvetica-Bold", 9),
    ("BACKGROUND", (0,-1), (-1,-1), CINZA_CLARO),
    ("ALIGN", (1,0), (1,-1), "CENTER"),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ("TOPPADDING", (0,0), (-1,-1), 5),
    ("LINEBELOW", (0,0), (-1,0), 0.5, LUMINUS_AZUL),
    ("GRID", (0,1), (-1,-2), 0.25, CINZA),
]))
story.append(Spacer(1, 4))
story.append(ob)
story.append(Spacer(1, 6))

# Bloco 5: Prompt
story.append(Paragraph("5. Prompt hibrido (gancho de obra + alvo Luminus)", H3))
story.append(Paragraph(
    "Refinamos a abordagem do Lucio para um modelo <b>hibrido</b>: ele abre a "
    "conversa pelo gancho da obra especifica (ex.: \"vi que voces estao tocando "
    "obra X em Y\"), mas o alvo comercial real e sempre <b>gerador definitivo "
    "+ MPaaS</b> (recorrencia). Locacao e Easy Luminus ficam reservados pra "
    "casos com aprovacao do comite de credito.",
    BODY,
))

# Bloco 6: Infra
story.append(Paragraph("6. Infraestrutura e operacao", H3))
for item in [
    "Bridge Node rodando em producao no Easypanel (lucio-bridge.2ep3tp.easypanel.host)",
    "Deploy manual controlado (sem auto-deploy &mdash; evita restart durante conversa ativa)",
    "Telefone E.164 normalizado &mdash; resolve duplicidade de contato no Chatwoot",
    "Skill <b>deploy-lucio</b> automatiza push + trigger de deploy",
]:
    story.append(Paragraph(f"&bull; {item}", BULLET))

story.append(Spacer(1, 10))

# === ESTADO ATUAL ===
story.append(Paragraph("Estado atual do sistema", H2))

estado = Table([
    ["Componente", "Status"],
    ["Bridge Node (cerebro do Lucio)", "CONSTRUIDO E NO AR"],
    ["Supabase (banco)", "CONSTRUIDO E NO AR"],
    ["Chatwoot (CRM espelho)", "CONSTRUIDO E NO AR"],
    ["uazapi (WhatsApp + chip dedicado Luminus)", "CONSTRUIDO E NO AR"],
    ["Cadencia automatica", "CONSTRUIDA &mdash; aguarda teste E2E"],
    ["Base de obras carregada", "379 leads disponiveis"],
], colWidths=[8.5*cm, 7*cm])
estado.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), LUMINUS_AZUL),
    ("TEXTCOLOR", (0,0), (-1,0), white),
    ("FONT", (0,0), (-1,0), "Helvetica-Bold", 9),
    ("FONT", (0,1), (-1,-1), "Helvetica", 9),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ("TOPPADDING", (0,0), (-1,-1), 5),
    ("GRID", (0,0), (-1,-1), 0.25, CINZA),
]))
story.append(estado)
story.append(Spacer(1, 12))

# === PROXIMOS PASSOS ===
story.append(Paragraph("Proximos passos imediatos", H2))
for n, item in enumerate([
    "<b>Smoke test E2E</b> com telefone real: simular jornada completa (lead chega, Lucio qualifica, vira SQL, closer assume, devolve, watchdog 1h, bot retoma)",
    "<b>Liberar disparo controlado</b>: 5-10 leads/dia para validar resposta de mercado antes de escalar",
    "<b>Calibrar cadencia</b> com base nos primeiros retornos reais (taxa de resposta, ratio MQL/SQL)",
], 1):
    story.append(Paragraph(f"<b>{n}.</b> {item}", BULLET))

story.append(Spacer(1, 10))

# === RISCOS / DEPENDENCIAS ===
story.append(Paragraph("O que depende de fora pra destravar", H2))
for item in [
    "<b>Alinhamento do time de closers</b> &mdash; treinar uso do Chatwoot e da label devolver-lucio",
]:
    story.append(Paragraph(f"&bull; {item}", BULLET))

story.append(Spacer(1, 12))

# === GLOSSARIO ===
story.append(Paragraph("Glossario rapido", H2))
gloss = Table([
    ["BDR", "Business Development Representative &mdash; vendedor de primeiro toque"],
    ["MQL", "Marketing Qualified Lead &mdash; demonstrou interesse"],
    ["SQL", "Sales Qualified Lead &mdash; pronto pra fechar com closer"],
    ["Handoff", "Passar atendimento de IA pra humano"],
    ["Cadencia", "Sequencia programada de toques ao longo de dias"],
    ["Jitter", "Variacao aleatoria de tempo entre mensagens (humaniza envio)"],
    ["MPaaS", "Manutencao como Servico &mdash; recorrencia mensal Luminus"],
    ["E2E", "End-to-end &mdash; teste do fluxo inteiro de ponta a ponta"],
], colWidths=[2.2*cm, 13.3*cm])
gloss.setStyle(TableStyle([
    ("FONT", (0,0), (0,-1), "Helvetica-Bold", 8),
    ("FONT", (1,0), (1,-1), "Helvetica", 8),
    ("TEXTCOLOR", (0,0), (-1,-1), CINZA),
    ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("BOTTOMPADDING", (0,0), (-1,-1), 2),
    ("TOPPADDING", (0,0), (-1,-1), 2),
]))
story.append(gloss)

story.append(Spacer(1, 14))
story.append(Paragraph(
    "<i>Relatorio gerado em 14/05/2026. Proxima atualizacao apos smoke test E2E.</i>",
    CAPTION,
))

doc.build(story)
print(f"OK -> {OUT}")
