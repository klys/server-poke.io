import { promises as fs } from "fs";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import path from "path";
import type { AuthenticatedUser } from "./Auth";

export default class MailService {
    private transporter:nodemailer.Transporter | null = null;
    private readonly emailTemplateCache = new Map<string, string>();
    private readonly smtpHost:string;
    private readonly smtpPort:number;
    private readonly smtpSecure:boolean;
    private readonly smtpUser:string;
    private readonly smtpPass:string;
    private readonly smtpFrom:string;
    private readonly smtpEnabled:boolean;
    private readonly appPublicUrl:string;
    private readonly emailValidationPath:string;
    private readonly passwordResetPath:string;

    constructor() {
        this.smtpEnabled = this.parseSmtpEnabled(process.env.SMTP_ENABLED);
        this.smtpHost = process.env.SMTP_HOST || "";
        this.smtpPort = Number(process.env.SMTP_PORT || 587);
        this.smtpSecure = (process.env.SMTP_SECURE || "false").toLowerCase() === "true";
        this.smtpUser = process.env.SMTP_USER || "";
        this.smtpPass = process.env.SMTP_PASS || "";
        this.smtpFrom = process.env.SMTP_FROM || "";
        this.appPublicUrl = (process.env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
        this.emailValidationPath = process.env.EMAIL_VALIDATION_PATH || "/#/validate-email";
        this.passwordResetPath = process.env.PASSWORD_RESET_PATH || "/#/recover-password";
    }

    public async initialize() {
        if (!this.isConfigured()) {
            console.warn("SMTP is not configured. Email delivery is disabled.");
            return;
        }

        const transportConfig:SMTPTransport.Options = {
            host: this.smtpHost,
            port: this.smtpPort,
            secure: this.smtpSecure,
            auth: {
                user: this.smtpUser,
                pass: this.smtpPass
            },
            requireTLS: true,
            tls: {
                minVersion: "TLSv1.2",
            },
        };

        this.transporter = nodemailer.createTransport(transportConfig);
        await this.transporter.verify();
    }

    public async sendWelcomeEmail(user:AuthenticatedUser) {
        const template = await this.renderTemplate("welcome.html", {
            NAME: user.name,
            USERNAME: user.username
        });

        await this.sendMail({
            to: user.email,
            subject: "Welcome to Poke.io",
            text: this.convertHtmlToText(template),
            html: template
        });
    }

    public async sendEmailValidationRequest(user:AuthenticatedUser, token:string) {
        const validationUrl = this.buildAppUrl(this.emailValidationPath, token);
        const template = await this.renderTemplate("email-validation.html", {
            NAME: user.name,
            VALIDATION_LINK: validationUrl
        });

        await this.sendMail({
            to: user.email,
            subject: "Validate your email address",
            text: this.convertHtmlToText(template),
            html: template
        });
    }

    public async sendUsernameRecoveryEmail(user:AuthenticatedUser) {
        const template = await this.renderTemplate("username-recovery.html", {
            NAME: user.name,
            USERNAME: user.username
        });

        await this.sendMail({
            to: user.email,
            subject: "Your Poke.io username",
            text: this.convertHtmlToText(template),
            html: template
        });
    }

    public async sendPasswordRecoveryEmail(user:AuthenticatedUser, token:string) {
        const recoveryUrl = this.buildAppUrl(this.passwordResetPath, token);
        const template = await this.renderTemplate("password-recovery.html", {
            NAME: user.name,
            PASSWORD_RESET_LINK: recoveryUrl
        });

        await this.sendMail({
            to: user.email,
            subject: "Reset your Poke.io password",
            text: this.convertHtmlToText(template),
            html: template
        });
    }

    private async sendMail(options:{ to:string; subject:string; text:string; html:string }) {
        if (!this.transporter) {
            console.warn(`Skipping email to ${options.to} because SMTP is not configured.`);
            return;
        }

        await this.transporter.sendMail({
            from: this.smtpFrom,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html
        });
    }

    public isEnabled() {
        return this.transporter !== null;
    }

    private isConfigured() {
        return Boolean(
            this.smtpEnabled &&
            this.smtpHost &&
            this.smtpPort &&
            this.smtpUser &&
            this.smtpPass &&
            this.smtpFrom
        );
    }

    private parseSmtpEnabled(value:string | undefined) {
        if (value === undefined || value.trim() === "") {
            return true;
        }

        return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
    }

    private buildAppUrl(path:string, token:string) {
        const separator = path.includes("?") ? "&" : "?";
        return `${this.appPublicUrl}${path}${separator}token=${encodeURIComponent(token)}`;
    }

    private async renderTemplate(templateFileName:string, replacements:Record<string, string>) {
        const template = await this.loadTemplate(templateFileName);
        let renderedTemplate = template;

        for (const [key, value] of Object.entries(replacements)) {
            renderedTemplate = renderedTemplate.split(`_${key}_`).join(this.escapeHtml(value));
        }

        return renderedTemplate;
    }

    private async loadTemplate(templateFileName:string) {
        const cachedTemplate = this.emailTemplateCache.get(templateFileName);
        if (cachedTemplate) {
            return cachedTemplate;
        }

        const candidatePaths = [
            process.env.EMAIL_TEMPLATES_DIR ? path.resolve(process.env.EMAIL_TEMPLATES_DIR, templateFileName) : "",
            path.resolve(process.cwd(), "emails", templateFileName),
            path.resolve(__dirname, "../emails", templateFileName)
        ].filter(Boolean);

        for (const candidatePath of candidatePaths) {
            try {
                const template = await fs.readFile(candidatePath, "utf8");
                this.emailTemplateCache.set(templateFileName, template);
                return template;
            } catch (error) {
                const fileError = error as NodeJS.ErrnoException;
                if (fileError.code !== "ENOENT") {
                    throw error;
                }
            }
        }

        throw new Error(`Email template "${templateFileName}" was not found. Checked: ${candidatePaths.join(", ")}`);
    }

    private convertHtmlToText(html:string) {
        return html
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_match, href:string, label:string) => `${label} (${href})`)
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6)>/gi, "\n\n")
            .replace(/<li>/gi, "- ")
            .replace(/<\/li>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"")
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    private escapeHtml(value:string) {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}
