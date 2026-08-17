export interface PendingCertificateError {
  url: string;
  error: string;
  fingerprint: string;
  isMainFrame: boolean;
  respond: (allow: boolean) => void;
}

export class CertificateErrorController {
  private pending: PendingCertificateError | null = null;

  begin(input: PendingCertificateError): boolean {
    if (!input.isMainFrame) return false;
    this.reject();
    this.pending = input;
    return true;
  }

  approve(url: string): boolean {
    if (!this.pending || this.pending.url !== url) return false;
    const pending = this.pending;
    this.pending = null;
    pending.respond(true);
    return true;
  }

  reject(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    pending.respond(false);
  }
}
