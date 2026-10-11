export const getCookies = () => {
  try {
    const cookies = document.cookie.split(";").reduce((res, c) => {
      const [key, val] = c.trim().split("=").map(decodeURIComponent);
      try {
        return Object.assign(res, { [key]: JSON.parse(val) });
      } catch (e) {
        return Object.assign(res, { [key]: val });
      }
    }, {});

    return cookies;
  } catch (error) {
    return "";
  }
};

export const getCookie = (key: string) => {
  const cookieList = getCookies();
  if (!Object.prototype.hasOwnProperty.call(cookieList, key)) {
    return "";
  }
  return cookieList[key];
};

export const setCookie = (key: string, value: string, expDays: number = 6) => {
  const date = new Date();
  date.setTime(date.getTime() + expDays * 24 * 60 * 60 * 1000);
  const expires = date.toUTCString();
  document.cookie = `${key}=${value}; expires=${expires}; path=/`;
};
