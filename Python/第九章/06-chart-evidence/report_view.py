"""将查询结果渲染为静态 SVG 与完整 HTML，不依赖 Node、CDN 或 Web 服务。"""

import math
import re


def create_chart_option(spec, rows):
    """本项目只开放区域销售额柱状图，不接收任意图表配置、脚本或额外数值。"""
    if (not isinstance(spec, dict) or set(spec) != {"type", "x", "y"}
            or spec["type"] != "bar" or spec["x"] != "region" or spec["y"] != "sales_amount"):
        raise ValueError("图表配置无效：仅支持 bar，x=region，y=sales_amount。")
    if not isinstance(rows, list) or len(rows) > 20:
        raise ValueError("图表数据无效，或分类超过 20 个，请缩小查询范围。")
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("region"), str) or not row["region"]
                or len(row["region"].encode("utf-16-le", errors="surrogatepass")) // 2 > 40
                or not isinstance(row.get("sales_amount"), str)
                or not re.fullmatch(r"[0-9]+\.[0-9]{2}", row["sales_amount"])
                or not math.isfinite(float(row["sales_amount"]))):
            raise ValueError("图表数据无效，或分类超过 20 个，请缩小查询范围。")
    # 沿用原示例的 dataset / encode 映射形状；这里是应用配置，不是 ECharts Python SDK。
    return {
        "animation": False,
        "textStyle": {"fontFamily": "PingFang SC, Microsoft YaHei, sans-serif", "fontSize": 15},
        "grid": {"left": 74, "right": 24, "top": 38, "bottom": 38},
        "dataset": {"dimensions": ["region", "sales_amount"], "source": rows},
        "xAxis": {"type": "category", "axisTick": {"show": False},
                  "axisLine": {"lineStyle": {"color": "#d5d9df"}}, "axisLabel": {"color": "#353c43"}},
        "yAxis": {"type": "value", "name": "元", "min": 0, "splitLine": {"lineStyle": {"color": "#edf0f2"}}},
        "series": [{"type": spec["type"], "encode": {"x": spec["x"], "y": spec["y"]}, "barMaxWidth": 82,
                    "colorBy": "data", "label": {"show": True, "position": "top",
                    "formatter": lambda item: item["data"]["sales_amount"], "color": "#252c32", "fontSize": 16}}],
        "color": ["#078578", "#dc9741", "#5681b3"],
    }


def escape(text):
    # 保留原模板的五种实体写法，同时用于 HTML 与 SVG 的数据文本。
    value = "null" if text is None else "true" if text is True else "false" if text is False else str(text)
    return re.sub(r"[&<>\"']", lambda match: {"&": "&amp;", "<": "&lt;", ">": "&gt;",
                  '"': "&quot;", "'": "&#39;"}[match[0]], value)


def conclusion(rows):
    """结论直接使用结果表的金额，不让模型另写数字或推测销售原因。"""
    if not rows:
        return "当前筛选条件下没有记录，无法据此判断销售额为 0。"
    highest = max(rows, key=lambda row: float(row["sales_amount"]))
    # 并列时保留原有顺序，以及原案例按金额字符串相等判断并列的规则。
    regions = "、".join(row["region"] for row in rows if row["sales_amount"] == highest["sales_amount"])
    return (f"本次已导入记录中，{highest['region']}未扣退款销售额为 {highest['sales_amount']} 元。" if len(rows) == 1
            else f"本次已导入记录中，{regions}未扣退款销售额最高，为 {highest['sales_amount']} 元。")


def _render_svg(option):
    """仅渲染本例柱状图；内嵌 SVG 直接由浏览器显示，不下载字体或执行脚本。"""
    rows = option["dataset"]["source"]
    series = option["series"][0]
    x_field, y_field = series["encode"]["x"], series["encode"]["y"]
    values = [float(row[y_field]) for row in rows]
    width, height = 800, 300
    grid = option["grid"]
    left, top = grid["left"], grid["top"]
    plot_width, plot_height = width - left - grid["right"], height - top - grid["bottom"]
    # 金额核对已在主流程用整数分完成；下面的浮点数只用于坐标位置。
    maximum = max(values) or 1
    raw_step = maximum / 4 * 1.15
    power = 10 ** math.floor(math.log10(raw_step))
    step = next(multiple * power for multiple in (1, 2, 2.5, 5, 10) if multiple * power >= raw_step)
    scale = math.ceil(maximum / step) * step
    ticks = round(scale / step)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300" role="img" aria-label="区域未扣退款销售额柱状图" style="font-family:{escape(option["textStyle"]["fontFamily"])};font-size:15px">',
             '<title>区域未扣退款销售额（人民币元）</title>']
    for index in range(ticks + 1):
        value = index * step
        y = top + plot_height * (1 - value / scale)
        # 刻度只是坐标说明，柱顶的金额仍使用原始字符串，不从刻度推导结论。
        label = f"{value:,.2f}".rstrip("0").rstrip(".")
        parts.append(f'<line x1="{left}" y1="{y:.3f}" x2="{left + plot_width}" y2="{y:.3f}" stroke="#edf0f2"/>')
        parts.append(f'<text x="{left - 12}" y="{y + 5:.3f}" text-anchor="end" fill="#657078">{label}</text>')
    bottom = top + plot_height
    parts.extend([f'<line x1="{left}" y1="{bottom}" x2="{left + plot_width}" y2="{bottom}" stroke="#d5d9df"/>',
                  f'<text x="{left}" y="{top - 16}" text-anchor="end" fill="#657078">元</text>'])
    spacing = plot_width / len(rows)
    bar_width = min(series["barMaxWidth"], spacing * 0.6)
    for index, (row, value) in enumerate(zip(rows, values)):
        center = left + spacing * (index + 0.5)
        bar_height = value / scale * plot_height
        y = bottom - bar_height
        color = option["color"][index % len(option["color"])]
        parts.append(f'<g class="bar"><title>{escape(row[x_field])}：{escape(row[y_field])} 元</title>')
        parts.append(f'<rect x="{center - bar_width / 2:.3f}" y="{y:.3f}" width="{bar_width:.3f}" height="{bar_height:.3f}" fill="{color}"/>')
        parts.append(f'<text x="{center:.3f}" y="{y - 10:.3f}" text-anchor="middle" fill="#252c32" font-size="16">{escape(series["label"]["formatter"]({"data": row}))}</text>')
        parts.append(f'<text x="{center:.3f}" y="{bottom + 24}" text-anchor="middle" fill="#353c43">{escape(row[x_field])}</text></g>')
    return "".join(parts) + "</svg>"


# 页面沿用原报告的区块与样式，保持结果、依据和下载入口的位置一致。
STYLE = """
:root{color-scheme:light;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#252c32;background:#fff;font-size:15px;letter-spacing:0}
*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:36px 40px 60px}header{border-bottom:2px solid #252c32;padding-bottom:22px}.eyebrow{font-size:13px;color:#078578;margin:0 0 12px}h1{font-size:28px;line-height:1.4;margin:0 0 12px}h2{font-size:19px;margin:0 0 20px}p{line-height:1.8;margin:12px 0}.muted{color:#657078;font-size:13px}.scope{display:flex;flex-wrap:wrap;gap:8px 24px;color:#59636a;font-size:14px}.overview{display:grid;grid-template-columns:minmax(0,2fr) minmax(230px,1fr);gap:32px;padding-top:24px}section{padding:26px 0;border-bottom:1px solid #dfe4e7;min-width:0}.chart{aspect-ratio:8/3}.chart svg{display:block;width:100%;height:100%}.insight{border-left:3px solid #078578;padding-left:14px;margin-top:18px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;background:#f5f7f8;color:#616a72;font-size:12px;font-weight:500}td,th{padding:13px 12px;border-bottom:1px solid #e7eaed;white-space:nowrap}.number{text-align:right;font-variant-numeric:tabular-nums}a{color:#007669;text-underline-offset:3px}summary{cursor:pointer;font-weight:600;padding:14px 0;line-height:1.6}summary span{font-weight:400;color:#657078;margin-left:12px}.evidence{padding:4px 0 16px;scroll-margin-top:16px}.evidence:target{outline:2px solid #078578;outline-offset:6px}.equation{font-variant-numeric:tabular-nums;color:#067365}.metadata{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px 20px;margin:16px 0;font-size:14px}.metadata dt{color:#657078}.metadata dd{margin:0;overflow-wrap:anywhere}pre{background:#f5f7f8;padding:18px;font-size:13px;line-height:1.7;overflow:auto}code{font-family:ui-monospace,monospace}.downloads{display:flex;gap:22px;flex-wrap:wrap;margin-top:22px}footer{margin-top:22px;font-size:12px;color:#77818a;overflow-wrap:anywhere}.empty{padding:50px 0;color:#657078}
@media(max-width:700px){main{padding:24px 18px 40px}h1{font-size:23px}.overview{grid-template-columns:1fr;gap:18px}.chart{min-height:200px;aspect-ratio:auto}.chart svg{height:auto;min-height:200px}summary span{display:block;margin-left:18px}.metadata{grid-template-columns:82px minmax(0,1fr);gap:10px}.scope{gap:8px 16px}}
@media print{main{padding:0}.downloads{display:none}details{break-inside:avoid}}
"""


def render_report(report):
    """生成完整 HTML，双击即可查看；没有数据时不生成零值图或复用旧图。"""
    svg = _render_svg(create_chart_option(report["chartSpec"], report["rows"])) if report["rows"] else ""
    result_rows, evidence = [], []
    for index, row in enumerate(report["rows"]):
        result_rows.append(f'<tr><td>{escape(row["region"])}</td><td class="number">{escape(row["sales_amount"])}</td><td><a href="#evidence-{index}">查看明细</a></td></tr>')
        details = [detail for detail in report["details"] if detail["region"] == row["region"]]
        table_rows = "".join(f'<tr><td>{escape(detail["source_row"])}</td><td>{escape(detail["line_id"])}</td><td>{escape(detail["sold_at"])}</td><td class="number">{escape(detail["paid_amount"])}</td></tr>' for detail in details)
        equation = " + ".join(escape(detail["paid_amount"]) for detail in details)
        evidence.append(f'''<details class="evidence" id="evidence-{index}" open>
      <summary>{escape(row["region"])} <span>{escape(row["sales_amount"])} 元 · {len(details)} 条明细</span></summary>
      <p class="muted">{escape(report["dataset"]["sourceFile"])} / {escape(report["dataset"]["sheet"])}</p>
      <div class="table-scroll"><table><thead><tr><th>Excel 行号</th><th>明细编号</th><th>销售日期</th><th class="number">实付金额（元）</th></tr></thead><tbody>{table_rows}</tbody></table></div>
      <p class="equation">{equation} = {escape(row["sales_amount"])} 元</p>
    </details>''')
    chart = svg or '<p class="empty">当前筛选条件下没有记录。</p>'
    result_table = "".join(result_rows) or '<tr><td colspan="3">无数据</td></tr>'
    evidence_html = "".join(evidence) or '<p class="muted">没有符合条件的明细，本报告不绘制零值柱状图。</p>'
    filters, dataset, metric = report["filters"], report["dataset"], report["metric"]
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape(filters["month"])} 区域销售分析</title>
<style>{STYLE}</style></head><body><main>
<header><p class="eyebrow">销售分析 / 查询结果与依据</p><h1>{escape(filters["month"])} 区域销售分析</h1><div class="scope"><span>指标：未扣退款销售额</span><span>单位：人民币元</span><span>范围：{escape(filters["region"] if filters["region"] is not None else "全部区域")} · 已导入记录</span></div></header>
<section><h2>查询结果</h2><div class="overview"><div class="chart">{chart}</div><div class="table-scroll"><table><thead><tr><th>区域</th><th class="number">金额（元）</th><th>依据</th></tr></thead><tbody>{result_table}</tbody></table></div></div><p class="insight">{escape(conclusion(report["rows"]))}</p><p class="muted">统计销售日期在 {escape(filters["start"])}（含）至 {escape(filters["end"])}（不含）的已导入记录；实付金额直接求和，未扣退款，不代表完整月度业绩。</p></section>
<section><h2>金额依据</h2>{evidence_html}</section>
<section><h2>查询与原始文件</h2><p>{escape(report["question"])}</p><dl class="metadata"><dt>原始文件</dt><dd>{escape(dataset["sourceFile"])}</dd><dt>工作表 / 表</dt><dd>{escape(dataset["sheet"])} / {escape(dataset["table"])}</dd><dt>数据版本</dt><dd><code>{escape(dataset["version"])}</code></dd><dt>指标计算</dt><dd><code>{escape(metric["expression"])}</code>，{escape(metric["unit"])}，未扣退款</dd></dl><details><summary>汇总 SQL</summary><pre><code>{escape(report["sql"])}</code></pre></details><details><summary>明细 SQL</summary><pre><code>{escape(report["detailSql"])}</code></pre></details><div class="downloads"><a href="source.xlsx" download>下载本次原文件</a><a href="report.json" download>下载完整依据 JSON</a></div></section>
<footer>报告编号 {escape(report["reportId"])} · {escape(report["createdAt"])}</footer>
</main></body></html>'''
