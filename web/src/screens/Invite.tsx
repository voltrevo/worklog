/**
 * Inviting a device, as a picture of a URL (27.23).
 *
 * The thing being handed over is a KPS address — an IP, a port and a certificate hash, which is
 * sixty-odd characters of hexadecimal. Reading that off one screen and typing it into another is
 * the worst part of setting this app up, and it is the *first* part, so it is the one that decides
 * whether somebody bothers. A camera does it in a second.
 *
 * **What is in the QR is not a credential.** It is this app's own URL with the address in the
 * fragment, which gets a device as far as the "ask for access" screen. An admin still approves it
 * (section 13). That is what makes it safe to put on a screen in a room, and it is worth saying in
 * the dialog rather than leaving somebody to wonder.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Sheet } from "./Sheet.tsx";
import { loadAddress } from "../deviceKeys.ts";
import { invitationTarget } from "../invite.ts";

export function Invite({ onClose }: { onClose: () => void }) {
  const address = loadAddress();
  const target = address ? invitationTarget(address) : undefined;
  const url = target?.text;
  const [png, setPng] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!url) return;
    let live = true;
    QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      // Fixed rather than themed: a QR is read by a camera, and inverting one for a dark page
      // makes it unreadable to about half of the scanners that exist. The white square it sits on
      // is in the CSS for the same reason.
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((data) => live && setPng(data))
      .catch((err: Error) => live && setFailed(err.message));
    return () => {
      live = false;
    };
  }, [url]);

  return (
    <Sheet label="Invite a device" onDismiss={onClose}>
      <div className="card stack" style={{ gap: 14 }}>
        <h2 style={{ margin: 0 }}>Invite a device</h2>

        {!url
          ? (
            <p className="notice warn" style={{ margin: 0 }}>
              This device does not have a server address stored, so there is nothing to hand over.
            </p>
          )
          : (
            <>
              <p style={{ margin: 0 }}>
                {target?.url
                  ? (
                    <>
                      Point a phone's camera at this. It opens Worklog, pointed at your server, and
                      asks for access — nothing is granted until an admin approves the request on
                      this screen.
                    </>
                  )
                  : (
                    <>
                      This window is a local file rather than a web page, so it has no address to
                      send anybody to. The code below is your server's address on its own: scan it
                      to copy, and paste it into Worklog on the other device. It will then ask for
                      access, and an admin approves it here.
                    </>
                  )}
              </p>

              <div className="qr">
                {png
                  ? <img src={png} alt={`QR code for ${url}`} width={320} height={320} />
                  : failed
                  ? <span className="faint">The code could not be drawn: {failed}</span>
                  : <span className="faint">Drawing…</span>}
              </div>

              {/* The same thing in text, for a device with no camera and for reading aloud. */}
              <label className="field">
                {target?.url ? "Or this link" : "Or this address"}
                {
                  /*
                   * Selected on focus so one keystroke copies it, and scrolled back to the front
                   * afterwards so the box shows an address rather than the tail of a certificate
                   * hash. Selecting scrolls to the caret and that happens after this handler
                   * returns, so the scroll has to be undone a frame later — `setSelectionRange`
                   * with a "backward" direction is the documented way and does not do it here.
                   */
                }
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => {
                    const box = e.currentTarget;
                    box.select();
                    requestAnimationFrame(() => (box.scrollLeft = 0));
                  }}
                />
              </label>
              <div className="row">
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(url)
                      .then(() => setCopied(true))
                      // A refused clipboard is not worth a message: the field above is right
                      // there, selects itself when touched, and is the fallback anyway.
                      .catch(() => {})}
                >
                  {copied ? "Copied" : target?.url ? "Copy link" : "Copy address"}
                </button>
                <button className="btn primary" type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

        {!url && (
          <div className="row">
            <button className="btn primary" type="button" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
