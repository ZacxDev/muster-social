// Every CSS selector the site adapters use, one table per site, so a site's
// markup change is a one-file fix.
//
// UNVERIFIED LIVE: none of these has been exercised against the live sites by
// this project. They are attributes and class names observed on the sites'
// pages (X's `data-testid` attributes, LinkedIn's class names), not a
// documented interface: either site can change them at any time, LinkedIn's
// more often. Every check that uses them fails CLOSED: a selector that matches
// nothing makes the adapter refuse before the click, and an EMPTY list read
// (the duplicate check) counts only when the page shows its empty-state marker;
// otherwise the page "did not load" and the adapter refuses. After the click,
// anything unread is "unknown". See the README's "Unverified live" section.

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
  /** A timeline that loaded and has no posts. An empty list WITHOUT this marker
   * is "did not load", never "none there". */
  emptyState: "[data-testid=emptyState]",
});

/** Lower-case labels of X's post/reply buttons: outside the gate, no action may
 * land inside a button labelled like this, whatever its selector. */
export const X_SUBMIT_LABELS: readonly string[] = Object.freeze(["post", "post all", "reply", "tweet", "tweet all"]);

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
  /** The media editor's confirm step after choosing files, scoped to the media
   * editor so it cannot be the share box's own footer button. */
  mediaNext: ".share-media-editor .share-box-footer__primary-btn",
  /** Thumbnails of the media attached to the share box. */
  postMediaPreview: ".share-creation-state__media-preview img, .share-creation-state__media-preview video",
  /** The share box's Post button. SUBMIT: only the gate may click it. */
  postSubmit: "button.share-actions__primary-action",
  /** A post (feed update); data-urn="urn:li:activity:<id>". */
  update: "[data-urn^=\"urn:li:activity:\"]",
  updateActorLink: ".update-components-actor__meta-link",
  updateText: ".update-components-text",
  updateMedia: ".update-components-image img, .update-components-linkedin-video video",
  /** The comment box under a post. The adapter prefixes these with the post's
   * own [data-urn=…] (see linkedin.ts scoped()), so they reach only the box of
   * the post whose author was checked. */
  commentEditor: ".comments-comment-box .ql-editor",
  commentFileInput: ".comments-comment-box input[type=file]",
  commentMediaPreview: ".comments-comment-box img.comments-comment-box__image-preview",
  /** The comment box's Comment button. SUBMIT: only the gate may click it. */
  commentSubmit: "button.comments-comment-box__submit-button",
  /** A list that loaded and is empty (no activity yet). An empty list WITHOUT
   * this marker is "did not load", never "none there". */
  emptyState: ".artdeco-empty-state",
  /** A comment; data-id="urn:li:comment:(activity:<post>,<comment>)". */
  comment: "article.comments-comment-entity",
  commentAuthorLink: "a.comments-comment-meta__description-container",
  commentText: ".comments-comment-item__main-content",
});

/** Lower-case labels of LinkedIn's post/comment buttons (see X_SUBMIT_LABELS). */
export const LINKEDIN_SUBMIT_LABELS: readonly string[] = Object.freeze(["post", "comment", "reply"]);
