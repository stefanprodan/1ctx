{{/* A Service name must start with a letter. */}}
{{- define "onectx.fullname" -}}
{{- $name := .Release.Name -}}
{{- if not (contains .Chart.Name .Release.Name) -}}
{{- $name = printf "%s-%s" .Release.Name .Chart.Name -}}
{{- end -}}
{{- if regexMatch "^[0-9]" $name -}}
{{- fail "the release name must start with a letter, such as onectx" -}}
{{- end -}}
{{- $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "onectx.version" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "onectx.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (include "onectx.version" .) -}}
{{- end -}}
{{- end -}}

{{/* The selector never changes across releases, so it holds no version. */}}
{{- define "onectx.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "onectx.labels" -}}
{{ include "onectx.selectorLabels" . }}
app.kubernetes.io/version: {{ include "onectx.version" . | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "onectx.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "onectx.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{- define "onectx.claimName" -}}
{{- .Values.persistence.existingClaim | default (include "onectx.fullname" .) -}}
{{- end -}}

{{/* Empty when nothing is provisioned. */}}
{{- define "onectx.provisionConfigMap" -}}
{{- with .Values.provision -}}
{{- if and .existingConfigMap .files -}}
{{- fail "set provision.existingConfigMap or provision.files, not both" -}}
{{- end -}}
{{- if .existingConfigMap -}}
{{- .existingConfigMap -}}
{{- else if .files -}}
{{- printf "%s-provision" (include "onectx.fullname" $) -}}
{{- end -}}
{{- end -}}
{{- end -}}
