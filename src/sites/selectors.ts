// Every CSS selector the site adapters use, one table per site, so a site's
// markup change is a one-file fix.
//
// UNVERIFIED LIVE: none of these has been exercised against the live sites by
// this project. The X entries follow publicly documented markup (stable
// `data-testid` attributes); the LinkedIn entries follow its publicly visible
// class names, which change more often. Every check that uses them fails
// CLOSED: a selector that matches nothing makes the adapter refuse before the
// click, never post blind. See the README's "Unverified live" section.

export const X_SELECTORS = Object.freeze({
  /** The signed-in account's profile link in the side bar: href="/<handle>". */
  accountLink: "a[data-testid=AppTabBar_Profile_Link]",
  /** The inline composer on the home timeline and under a status. */
  composer: "[data-testid=tweetTextarea_0]",
  /** Links inside the composer (a typed @word becomes one). */
  composerLinks: "[data-testid=tweetTextarea_0] a",
  /** The inline Post / Reply button. SUBMIT: only the gate may click it. */
  submit: "[data-testid=tweetButtonInline]",
  fileInput: "input[data-testid=fileInput]",
  /** Attachment previews in the composer, and their upload progress. */
  attachments: "[data-testid=attachments]",
  attachmentMedia: "[data-testid=attachments] img, [data-testid=attachments] video",
  attachmentBusy: "[data-testid=attachments] [role=progressbar]",
  /** A post on a timeline or status page. */
  article: "article",
  /** Inside an article: its permalink (the <time> sits in it), text, media. */
  articlePermalinkTime: "a[href*=\"/status/\"] time",
  articleText: "[data-testid=tweetText]",
  articleMedia: "[data-testid=tweetPhoto], [data-testid=videoPlayer]",
});

export const LINKEDIN_SELECTORS = Object.freeze({
  /** Present only when signed in: the "Me" item of the global nav. */
  signedInMarker: ".global-nav__me",
  /** The signed-in member's own profile link on the feed's left rail. */
  ownProfileLink: ".feed-identity-module a[href*=\"/in/\"]",
  /** Opens the share box on the feed. */
  startPost: "button.share-box-feed-entry__trigger",
  /** The share box's editor (a contenteditable). */
  postEditor: ".share-creation-state__text-editor .ql-editor",
  /** Mention entities inside an editor. */
  editorMentions: ".ql-mention, a[href*=\"/in/\"]",
  /** The share box's "Add media" control (opens a file chooser). */
  addMedia: "button[aria-label=\"Add media\"]",
  /** The media editor's confirm step after choosing files. */
  mediaNext: ".share-box-footer__primary-btn",
  /** Thumbnails of the media attached to the share box. */
  postMediaPreview: ".share-creation-state__media-preview img, .share-creation-state__media-preview video",
  /** The share box's Post button. SUBMIT: only the gate may click it. */
  postSubmit: "button.share-actions__primary-action",
  /** A post (feed update); data-urn="urn:li:activity:<id>". */
  update: "[data-urn^=\"urn:li:activity:\"]",
  updateActorLink: ".update-components-actor__meta-link",
  updateText: ".update-components-text",
  updateMedia: ".update-components-image img, .update-components-linkedin-video video",
  /** The comment box under a post. */
  commentEditor: ".comments-comment-box .ql-editor",
  commentFileInput: ".comments-comment-box input[type=file]",
  commentMediaPreview: ".comments-comment-box img.comments-comment-box__image-preview",
  /** The comment box's Comment button. SUBMIT: only the gate may click it. */
  commentSubmit: "button.comments-comment-box__submit-button",
  /** A comment; data-id="urn:li:comment:(activity:<post>,<comment>)". */
  comment: "article.comments-comment-entity",
  commentAuthorLink: "a.comments-comment-meta__description-container",
  commentText: ".comments-comment-item__main-content",
});
