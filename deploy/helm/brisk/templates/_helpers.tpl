{{- define "brisk.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brisk.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "brisk.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brisk.labels" -}}
app.kubernetes.io/name: {{ include "brisk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "brisk.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brisk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "brisk.secretName" -}}
{{- if .Values.existingSecret }}{{ .Values.existingSecret }}{{ else }}{{ include "brisk.fullname" . }}{{ end -}}
{{- end -}}
