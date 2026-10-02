{{/*
A Service name must start with a letter, so a leading 1ctx is spelled
onectx and any other leading digit gets that prefix.
*/}}
{{- define "1ctx.fullname" -}}
{{- $name := .Release.Name -}}
{{- if not (contains .Chart.Name .Release.Name) -}}
{{- $name = printf "%s-%s" .Release.Name .Chart.Name -}}
{{- end -}}
{{- $name = regexReplaceAll "^1ctx" $name "onectx" -}}
{{- if regexMatch "^[0-9]" $name -}}
{{- $name = printf "onectx-%s" $name -}}
{{- end -}}
{{- $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "1ctx.version" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "1ctx.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (include "1ctx.version" .) -}}
{{- end -}}
{{- end -}}

{{/* The selector never changes across releases, so it holds no version. */}}
{{- define "1ctx.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "1ctx.labels" -}}
{{ include "1ctx.selectorLabels" . }}
app.kubernetes.io/version: {{ include "1ctx.version" . | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "1ctx.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "1ctx.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{- define "1ctx.claimName" -}}
{{- .Values.persistence.existingClaim | default (include "1ctx.fullname" .) -}}
{{- end -}}

{{/* Empty when nothing is provisioned. */}}
{{- define "1ctx.provisionConfigMap" -}}
{{- with .Values.provision -}}
{{- if and .existingConfigMap .files -}}
{{- fail "set provision.existingConfigMap or provision.files, not both" -}}
{{- end -}}
{{- if .existingConfigMap -}}
{{- .existingConfigMap -}}
{{- else if .files -}}
{{- printf "%s-provision" (include "1ctx.fullname" $) -}}
{{- end -}}
{{- end -}}
{{- end -}}
