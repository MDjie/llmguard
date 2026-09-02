{{- define "guardllm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "guardllm.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "guardllm.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "guardllm.labels" -}}
app.kubernetes.io/name: {{ include "guardllm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "guardllm.image" -}}
{{- $root := index . 0 -}}
{{- $key := index . 1 -}}
{{- $image := index $root.Values.images $key -}}
{{- printf "%s@%s" (required (printf "images.%s.repository is required" $key) $image.repository) (required (printf "images.%s.digest is required" $key) $image.digest) -}}
{{- end }}
