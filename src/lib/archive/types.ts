export type RecruitmentType = "NIS" | "NIDU" | "other" | "unknown";
export type AssetKind =
  | "attachment"
  | "avatar"
  | "emoji"
  | "sticker"
  | "embed_image";

export interface ArchiveConfig {
  baseUrl: string;
  token: string;
  postTimeoutMs: number;
  getTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxRequestBytes: number;
}
/** allowInsecureHttp is for the local E2E only (like the archive's ARCHIVE_TEST_LOCAL_ATTACHMENT_HTTP); never set from the environment. */
export interface AssetPolicy {
  hosts: string[];
  mimeTypes: string[];
  maxAttachmentBytes: number;
  allowInsecureHttp?: boolean;
}
export type OmissionReason =
  | "host_not_allowed"
  | "mime_not_allowed"
  | "too_large"
  | "metadata_unavailable";
/** An optional asset (avatar, emoji, sticker, embed image) left out of the archive. No URL: it may be signed. */
export interface OmittedAsset {
  kind: AssetKind;
  source_discord_id: string | null;
  reason: OmissionReason;
}
export interface ArchiveAsset {
  kind: AssetKind;
  source_discord_id: string | null;
  source_url: string;
  filename: string;
  content_type: string;
  size: number;
  owner_reference: Record<string, unknown>;
}
export interface ConsultationPayload {
  schema_version: 2;
  discord_guild_id: string;
  discord_channel_id: string;
  channel_name: string;
  recruitment_type: RecruitmentType;
  applicant_discord_id: string;
  applicant_display_name: string;
  completed_by_discord_id: string;
  completed_by_display_name: string;
  started_at: string;
  captured_at: string;
  cutoff_message_id: string;
  closed_at: string;
  guild: Record<string, unknown>;
  channel: Record<string, unknown>;
  permission_snapshot: Record<string, unknown>;
  raw_snapshot: Record<string, unknown>;
  participants: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  assets: ArchiveAsset[];
}
export interface AttachmentVerification {
  discord_attachment_id: string;
  sha256: string;
  actual_size: number;
  verified: boolean;
}
export interface AssetVerification {
  asset_id: string;
  kind: AssetKind;
  source_discord_id: string | null;
  filename: string;
  content_type: string;
  declared_size: number;
  sha256: string;
  actual_size: number;
  owner_reference: Record<string, unknown>;
  verified: boolean;
}
export interface Counts {
  participants: number;
  messages: number;
  attachments: number;
  assets: number;
}
/** intel-archive's ArchiveResponse after normalizeResponse filled the fields the server omits at their defaults. */
export interface ArchiveResponse {
  archive_id: string;
  schema_version: number;
  status: "verified" | "failed";
  discord_guild_id: string;
  discord_channel_id: string;
  cutoff_message_id: string;
  sorted_message_ids: string[];
  attachments: AttachmentVerification[];
  assets: AssetVerification[];
  discord_snapshot: Record<string, unknown>;
  verification: {
    complete: boolean;
    submitted: Counts;
    stored: Counts;
    ordering_verified: boolean;
    attachments_verified: boolean;
    assets_verified: boolean;
    manifest_verified: boolean;
  };
  manifest_digest: string;
  failure_reason: string | null;
  idempotent_replay: boolean;
}
