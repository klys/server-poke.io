import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { AuthenticatedUser } from "./Auth";

export default class MailService {
    private transporter:nodemailer.Transporter | null = null;
    private readonly smtpHost:string;
    private readonly smtpPort:number;
    private readonly smtpSecure:boolean;
    private readonly smtpUser:string;
    private readonly smtpPass:string;
    private readonly smtpFrom:string;
    private readonly appPublicUrl:string;
    private readonly emailValidationPath:string;
    private readonly passwordResetPath:string;

    constructor() {
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
            }
        };

        this.transporter = nodemailer.createTransport(transportConfig);
        await this.transporter.verify();
    }

    public async sendWelcomeEmail(user:AuthenticatedUser) {
        await this.sendMail({
            to: user.email,
            subject: "Welcome to Poke.io",
            text: [
                `Hi ${user.name},`,
                "",
                `Welcome to Poke.io. Your username is ${user.username}.`,
                "",
                "We are glad to have you here."
            ].join("\n"),
            html: [
                `<p>Hi ${user.name},</p>`,
                `<p>Welcome to <strong>Poke.io</strong>. Your username is <strong>${user.username}</strong>.</p>`,
                `<p>We are glad to have you here.</p>`
            ].join("")
        });
    }

    public async sendEmailValidationRequest(user:AuthenticatedUser, token:string) {
        const validationUrl = this.buildAppUrl(this.emailValidationPath, token);
        await this.sendMail({
            to: user.email,
            subject: "Validate your email address",
            text: [
                `Hi ${user.name},`,
                "",
                "Please validate your email address by opening this link:",
                validationUrl
            ].join("\n"),
            html: [
                `<p>Hi ${user.name},</p>`,
                `<p>Please validate your email address by opening this link:</p>`,
                `<p><a href="${validationUrl}">${validationUrl}</a></p>`
            ].join("")
        });
    }

    public async sendUsernameRecoveryEmail(user:AuthenticatedUser) {
        await this.sendMail({
            to: user.email,
            subject: "Your Poke.io username",
            text: [
                `Hi ${user.name},`,
                "",
                `The username associated with this email is: ${user.username}`
            ].join("\n"),
            html: [
                `<p>Hi ${user.name},</p>`,
                `<p>The username associated with this email is <strong>${user.username}</strong>.</p>`
            ].join("")
        });
    }

    public async sendPasswordRecoveryEmail(user:AuthenticatedUser, token:string) {
        const recoveryUrl = this.buildAppUrl(this.passwordResetPath, token);
        await this.sendMail({
            to: user.email,
            subject: "Reset your Poke.io password",
            text: [
                `Hi ${user.name},`,
                "",
                "Use the following link to reset your password:",
                recoveryUrl
            ].join("\n"),
            html: [
                `<p>Hi ${user.name},</p>`,
                `<p>Use the following link to reset your password:</p>`,
                `<p><a href="${recoveryUrl}">${recoveryUrl}</a></p>`
            ].join("")
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

    private isConfigured() {
        return Boolean(
            this.smtpHost &&
            this.smtpPort &&
            this.smtpUser &&
            this.smtpPass &&
            this.smtpFrom
        );
    }

    private buildAppUrl(path:string, token:string) {
        const separator = path.includes("?") ? "&" : "?";
        return `${this.appPublicUrl}${path}${separator}token=${encodeURIComponent(token)}`;
    }
}
