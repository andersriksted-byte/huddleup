// Skalerer et billede ned til en lille data-URL, før det gemmes i Firestore.
// Firestore-dokumenter må max fylde 1 MB — et rå kamerafoto kan sagtens fylde flere MB, så
// uden nedskalering ville profilbilleder før eller siden ødelægge synkroniseringen. Vi
// begrænser derfor alle profil-/forespørgsels-billeder til maks 192×192 px som JPEG.
export function resizeImageToDataURL(file, maxSize = 192, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Kunne ikke læse filen."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Kunne ikke læse billedet."));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
