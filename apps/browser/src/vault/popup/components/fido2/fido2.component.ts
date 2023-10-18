import { Component, OnDestroy, OnInit } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import {
  BehaviorSubject,
  combineLatest,
  concatMap,
  filter,
  map,
  Observable,
  Subject,
  take,
  takeUntil,
} from "rxjs";

import { SearchService } from "@bitwarden/common/abstractions/search.service";
import { SettingsService } from "@bitwarden/common/abstractions/settings.service";
import { SecureNoteType } from "@bitwarden/common/enums";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CipherType } from "@bitwarden/common/vault/enums/cipher-type";
import { CardView } from "@bitwarden/common/vault/models/view/card.view";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { IdentityView } from "@bitwarden/common/vault/models/view/identity.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";
import { SecureNoteView } from "@bitwarden/common/vault/models/view/secure-note.view";
import { DialogService } from "@bitwarden/components";
import { PasswordRepromptService } from "@bitwarden/vault";

import { BrowserApi } from "../../../../platform/browser/browser-api";
import {
  BrowserFido2Message,
  BrowserFido2UserInterfaceSession,
} from "../../../fido2/browser-fido2-user-interface.service";

interface ViewData {
  message: BrowserFido2Message;
  fallbackSupported: boolean;
}

@Component({
  selector: "app-fido2",
  templateUrl: "fido2.component.html",
  styleUrls: [],
})
export class Fido2Component implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  private hasSearched = false;
  private searchTimeout: any = null;
  private hasLoadedAllCiphers = false;

  protected cipher: CipherView;
  protected searchTypeSearch = false;
  protected searchPending = false;
  protected searchText: string;
  protected url: string;
  protected hostname: string;
  protected data$: Observable<ViewData>;
  protected sessionId?: string;
  protected senderTabId?: string;
  protected ciphers?: CipherView[] = [];
  protected displayedCiphers?: CipherView[] = [];
  protected loading = false;
  protected subtitleText: string;
  protected credentialText: string;

  private message$ = new BehaviorSubject<BrowserFido2Message>(null);

  constructor(
    private router: Router,
    private activatedRoute: ActivatedRoute,
    private cipherService: CipherService,
    private passwordRepromptService: PasswordRepromptService,
    private platformUtilsService: PlatformUtilsService,
    private settingsService: SettingsService,
    private searchService: SearchService,
    private logService: LogService,
    private dialogService: DialogService
  ) {}

  ngOnInit() {
    this.searchTypeSearch = !this.platformUtilsService.isSafari();

    const queryParams$ = this.activatedRoute.queryParamMap.pipe(
      take(1),
      map((queryParamMap) => ({
        sessionId: queryParamMap.get("sessionId"),
        senderTabId: queryParamMap.get("senderTabId"),
        senderUrl: queryParamMap.get("senderUrl"),
      }))
    );

    combineLatest([queryParams$, BrowserApi.messageListener$() as Observable<BrowserFido2Message>])
      .pipe(
        concatMap(async ([queryParams, message]) => {
          this.sessionId = queryParams.sessionId;
          this.senderTabId = queryParams.senderTabId;
          this.url = queryParams.senderUrl;
          // For a 'NewSessionCreatedRequest', abort if it doesn't belong to the current session.
          if (
            message.type === "NewSessionCreatedRequest" &&
            message.sessionId !== queryParams.sessionId
          ) {
            this.abort(false);
            return;
          }

          // Ignore messages that don't belong to the current session.
          if (message.sessionId !== queryParams.sessionId) {
            return;
          }

          if (message.type === "AbortRequest") {
            this.abort(false);
            return;
          }

          // Show dialog if user account does not have master password
          if (!(await this.passwordRepromptService.enabled())) {
            await this.dialogService.openSimpleDialog({
              title: { key: "featureNotSupported" },
              content: { key: "passkeyFeatureIsNotImplementedForAccountsWithoutMasterPassword" },
              acceptButtonText: { key: "ok" },
              cancelButtonText: null,
              type: "info",
            });

            this.abort(true);
            return;
          }

          return message;
        }),
        filter((message) => !!message),
        takeUntil(this.destroy$)
      )
      .subscribe((message) => {
        this.message$.next(message);
      });

    this.data$ = this.message$.pipe(
      filter((message) => message != undefined),
      concatMap(async (message) => {
        switch (message.type) {
          case "ConfirmNewCredentialRequest": {
            const equivalentDomains = this.settingsService.getEquivalentDomains(this.url);

            this.ciphers = (await this.cipherService.getAllDecrypted()).filter(
              (cipher) => cipher.type === CipherType.Login && !cipher.isDeleted
            );
            this.displayedCiphers = this.ciphers.filter((cipher) =>
              cipher.login.matchesUri(this.url, equivalentDomains)
            );

            if (this.displayedCiphers.length > 0) {
              this.selectedPasskey(this.displayedCiphers[0]);
            }
            break;
          }

          case "PickCredentialRequest": {
            this.ciphers = await Promise.all(
              message.cipherIds.map(async (cipherId) => {
                const cipher = await this.cipherService.get(cipherId);
                return cipher.decrypt(
                  await this.cipherService.getKeyForCipherKeyDecryption(cipher)
                );
              })
            );
            this.displayedCiphers = [...this.ciphers];
            if (this.displayedCiphers.length > 0) {
              this.selectedPasskey(this.displayedCiphers[0]);
            }
            break;
          }

          case "InformExcludedCredentialRequest": {
            this.ciphers = await Promise.all(
              message.existingCipherIds.map(async (cipherId) => {
                const cipher = await this.cipherService.get(cipherId);
                return cipher.decrypt(
                  await this.cipherService.getKeyForCipherKeyDecryption(cipher)
                );
              })
            );
            this.displayedCiphers = [...this.ciphers];

            if (this.displayedCiphers.length > 0) {
              this.selectedPasskey(this.displayedCiphers[0]);
            }
            break;
          }
        }

        this.subtitleText =
          this.displayedCiphers.length > 0
            ? this.getCredentialSubTitleText(message.type)
            : "noMatchingPasskeyLogin";

        this.credentialText = this.getCredentialButtonText(message.type);
        return {
          message,
          fallbackSupported: "fallbackSupported" in message && message.fallbackSupported,
        };
      }),
      takeUntil(this.destroy$)
    );

    queryParams$.pipe(takeUntil(this.destroy$)).subscribe((queryParams) => {
      this.send({
        sessionId: queryParams.sessionId,
        type: "ConnectResponse",
      });
    });
  }

  async submit() {
    const data = this.message$.value;
    if (data?.type === "PickCredentialRequest") {
      const userVerified = await this.handleUserVerification(data.userVerification, this.cipher);

      this.send({
        sessionId: this.sessionId,
        cipherId: this.cipher.id,
        type: "PickCredentialResponse",
        userVerified,
      });
    } else if (data?.type === "ConfirmNewCredentialRequest") {
      if (this.cipher.login.hasFido2Credentials) {
        const confirmed = await this.dialogService.openSimpleDialog({
          title: { key: "overwritePasskey" },
          content: { key: "overwritePasskeyAlert" },
          type: "info",
        });

        if (!confirmed) {
          return false;
        }
      }

      const userVerified = await this.handleUserVerification(data.userVerification, this.cipher);

      this.send({
        sessionId: this.sessionId,
        cipherId: this.cipher.id,
        type: "ConfirmNewCredentialResponse",
        userVerified,
      });
    }

    this.loading = true;
  }

  async saveNewLogin() {
    const data = this.message$.value;
    if (data?.type === "ConfirmNewCredentialRequest") {
      let userVerified = false;
      if (data.userVerification) {
        userVerified = await this.passwordRepromptService.showPasswordPrompt();
      }

      if (!data.userVerification || userVerified) {
        await this.createNewCipher();
      }

      this.send({
        sessionId: this.sessionId,
        cipherId: this.cipher?.id,
        type: "ConfirmNewCredentialResponse",
        userVerified,
      });
    }

    this.loading = true;
  }

  getCredentialSubTitleText(messageType: string): string {
    return messageType == "ConfirmNewCredentialRequest" ? "choosePasskey" : "logInWithPasskey";
  }

  getCredentialButtonText(messageType: string): string {
    return messageType == "ConfirmNewCredentialRequest" ? "savePasskey" : "confirm";
  }

  selectedPasskey(item: CipherView) {
    this.cipher = item;
  }

  viewPasskey() {
    this.router.navigate(["/view-cipher"], {
      queryParams: {
        cipherId: this.cipher.id,
        uilocation: "popout",
        senderTabId: this.senderTabId,
        sessionId: this.sessionId,
      },
    });
  }

  addCipher() {
    const data = this.message$.value;

    if (data?.type !== "ConfirmNewCredentialRequest") {
      return;
    }

    this.router.navigate(["/add-cipher"], {
      queryParams: {
        name: Utils.getHostname(this.url),
        uri: this.url,
        uilocation: "popout",
        senderTabId: this.senderTabId,
        sessionId: this.sessionId,
        userVerification: data.userVerification,
      },
    });
  }

  async loadLoginCiphers() {
    this.ciphers = (await this.cipherService.getAllDecrypted()).filter(
      (cipher) => cipher.type === CipherType.Login && !cipher.isDeleted
    );
    if (!this.hasLoadedAllCiphers) {
      this.hasLoadedAllCiphers = !this.searchService.isSearchable(this.searchText);
    }
    await this.search(null);
  }

  async search(timeout: number = null) {
    this.searchPending = false;
    if (this.searchTimeout != null) {
      clearTimeout(this.searchTimeout);
    }

    if (timeout == null) {
      this.hasSearched = this.searchService.isSearchable(this.searchText);
      this.displayedCiphers = await this.searchService.searchCiphers(
        this.searchText,
        null,
        this.ciphers
      );
      return;
    }
    this.searchPending = true;
    this.searchTimeout = setTimeout(async () => {
      this.hasSearched = this.searchService.isSearchable(this.searchText);
      if (!this.hasLoadedAllCiphers && !this.hasSearched) {
        await this.loadLoginCiphers();
      } else {
        this.displayedCiphers = await this.searchService.searchCiphers(
          this.searchText,
          null,
          this.ciphers
        );
      }
      this.searchPending = false;
      this.selectedPasskey(this.displayedCiphers[0]);
    }, timeout);
  }

  abort(fallback: boolean) {
    this.unload(fallback);
    window.close();
  }

  unload(fallback = false) {
    this.send({
      sessionId: this.sessionId,
      type: "AbortResponse",
      fallbackRequested: fallback,
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private buildCipher() {
    this.cipher = new CipherView();
    this.cipher.name = Utils.getHostname(this.url);
    this.cipher.type = CipherType.Login;
    this.cipher.login = new LoginView();
    this.cipher.login.uris = [new LoginUriView()];
    this.cipher.login.uris[0].uri = this.url;
    this.cipher.card = new CardView();
    this.cipher.identity = new IdentityView();
    this.cipher.secureNote = new SecureNoteView();
    this.cipher.secureNote.type = SecureNoteType.Generic;
    this.cipher.reprompt = CipherRepromptType.None;
  }

  private async createNewCipher() {
    this.buildCipher();
    const cipher = await this.cipherService.encrypt(this.cipher);
    try {
      await this.cipherService.createWithServer(cipher);
      this.cipher.id = cipher.id;
    } catch (e) {
      this.logService.error(e);
    }
  }

  private async handleUserVerification(
    userVerification: boolean,
    cipher: CipherView
  ): Promise<boolean> {
    const masterPasswordRepromptRequiered = cipher && cipher.reprompt !== 0;
    const verificationRequired = userVerification || masterPasswordRepromptRequiered;

    if (!verificationRequired) {
      return false;
    }

    return await this.passwordRepromptService.showPasswordPrompt();
  }

  private send(msg: BrowserFido2Message) {
    BrowserFido2UserInterfaceSession.sendMessage({
      sessionId: this.sessionId,
      ...msg,
    });
  }
}
