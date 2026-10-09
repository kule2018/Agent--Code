<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Chart } from '../../shared/types'
echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])
const props = defineProps<{ chart: Chart }>()
const element = ref<HTMLElement>()
let instance: echarts.ECharts | undefined, observer: ResizeObserver
function draw() {
  const chart = props.chart
  instance?.setOption({ animation: false, color: ['#087f72', '#4384c5', '#b4782e'],
    grid: { left: 65, right: 20, top: 45, bottom: 48 }, tooltip: { trigger: 'axis' }, legend: { top: 0, textStyle: { fontSize: 12 } },
    xAxis: { type: 'category', data: chart.categories, axisLabel: { fontSize: 11 }, axisLine: { lineStyle: { color: '#b7c5cf' } } },
    yAxis: { type: 'value', name: chart.unit, splitLine: { lineStyle: { color: '#edf0f3' } } },
    series: chart.series.map(s => ({ name: s.name, type: chart.kind, data: s.values, connectNulls: false, barMaxWidth: 45, symbolSize: 7, lineStyle: { width: 3 } }))
  }, true)
}
onMounted(() => { instance = echarts.init(element.value!); draw(); observer = new ResizeObserver(() => instance?.resize()); observer.observe(element.value!) })
watch(() => props.chart, draw, { deep: true })
onBeforeUnmount(() => { observer?.disconnect(); instance?.dispose() })
</script>
<template><div ref="element" class="chart-canvas" role="img" :aria-label="chart.title"></div></template>
