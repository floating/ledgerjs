// @flow
import { Observable } from "rxjs";
import type { Characteristic } from "./types";
import { logSubject } from "./debug";

export const monitorCharacteristic = (
  characteristic: Characteristic
): Observable<Buffer> =>
  Observable.create(o => {
    logSubject.next({
      type: "verbose",
      message: "start monitor " + characteristic.uuid
    });

    characteristic.on('data', data => o.next(Buffer.from(data)));
    characteristic.subscribe(err => { if (err) throw err });

    return () => {
      logSubject.next({
        type: "verbose",
        message: "end monitor " + characteristic.uuid
      });
      characteristic.unsubscribe();
    };
  });
