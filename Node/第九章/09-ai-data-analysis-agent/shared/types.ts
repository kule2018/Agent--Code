export type Mode = 'replay' | 'ai'
export type Metric = 'net' | 'paid' | 'refund'
export type AnalysisKind = 'trend' | 'decline' | 'contribution' | 'summary'
export type Row = Record<string, string | number | boolean | null>
export type Issue = { row: number; field: string; message: string }
export type ColumnMap = { date: string; region: string; product: string; paid: string; refund: string }
export type SheetPreview = { name: string; headers: string[]; rows: unknown[][]; suggested: ColumnMap }
export type UploadPreview = { id: string; filename: string; sheets: SheetPreview[] }
export type Dataset = {
  id: string; name: string; sheet: string; version: number; checksum: string; createdAt: string;
  rowCount: number; status: 'ready' | 'needs_review'; issues: Issue[];
  start: string | null; end: string | null; regions: string[]; products: string[]; mapping: ColumnMap
}
export type Spec = { kind: AnalysisKind; metric: Metric; start: string; end: string; region: string | null }
export type Decision = { route: 'query' | 'clarify' | 'insufficient'; spec: Spec | null; sql: string | null; message: string }
export type Chart = { kind: 'line' | 'bar'; title: string; categories: string[]; series: { name: string; values: (number | null)[] }[]; unit: string }
export type Evidence = {
  id: string; sql: string; rows: Row[]; dataset: Dataset; spec: Spec; createdAt: string; durationMs: number
}
export type Report = {
  id: string; question: string; answer: string; mode: Mode; status: 'completed' | 'clarify' | 'insufficient';
  evidence: Evidence | null; table: Row[]; chart: Chart | null; notes: string[]; createdAt: string
}
export type Session = { id: string; datasetId: string; title: string; createdAt: string; reports: Report[]; lastSpec: Spec | null }
export type Progress = { stage: string; message: string }
export type PictureFacts = {
  title: string; start: string | null; end: string | null; metric: Metric | 'unknown';
  unit: '元' | '万元' | 'unknown'; region: string | null; amount: number | null; uncertainties: string[]
}
