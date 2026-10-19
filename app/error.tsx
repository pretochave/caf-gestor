'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="not-found"><span className="eyebrow">VAMOS TENTAR NOVAMENTE</span><h1>Algo interrompeu<br/>este carregamento.</h1><p>Seus dados salvos continuam no banco. Tente abrir a página outra vez.</p><button className="btn btn-primary" onClick={reset}>Tentar novamente</button></main>}
